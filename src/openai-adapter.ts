import type { ChatMessage, ChatRequest, ChatResponse, ModelAdapter } from "./types.ts";

export interface OpenAIChatAdapterOptions {
  /** Base URL including the version segment, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /**
   * Ask the provider to stream (`stream: true`) and assemble the SSE transcript
   * back into the ordinary {@link ChatResponse}.
   *
   * Off by default, because it changes the request body: this project only sends
   * `stream_options.include_usage` on this path, and a server that rejects unknown
   * fields should not have to reject the default path too. What streaming buys here
   * is compatibility (endpoints that only stream now work) plus the same byte
   * ceiling and abortability as the non-streaming path — **not** incremental
   * display; see `parseSseCompletion` for that boundary.
   */
  stream?: boolean;
}

import { record, tokenCount, validateResponse } from "./response-validation.ts";
import { readBoundedUtf8 } from "./bounded-read.ts";

/**
 * Hard ceiling for one provider response body.
 *
 * A broken or hostile endpoint behind a proxy can stream forever; without a
 * ceiling the process buffers it all before any validation runs.
 */
export const CHAT_RESPONSE_MAX_BYTES = 1024 * 1024;

/**
 * Serialize one message into the OpenAI wire shape.
 *
 * The internal `ToolCall` already mirrors `{id, name, arguments}`, but on the
 * wire a call is nested under `function` and carries an explicit `type`, and a
 * tool result must cite `tool_call_id`. Translating only here keeps the rest of
 * the codebase free of wire-format trivia.
 */
function toWireMessage(message: ChatMessage): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: message.role, content: message.content };
  if (message.toolCalls && message.toolCalls.length > 0) {
    wire.tool_calls = message.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (message.toolCallId !== undefined) wire.tool_call_id = message.toolCallId;
  return wire;
}

/**
 * Read a provider's reasoning trace.
 *
 * `null` and absent both mean "this provider does not expose one". Any other
 * non-string is refused rather than coerced: showing `[object Object]` as a model's
 * reasoning would be worse than showing nothing.
 */
function readReasoning(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("invalid model response: reasoning_content");
  return value;
}

/**
 * Assemble an SSE transcript into the same payload shape a non-streaming response
 * would have, so every step after this point stays on the existing code path.
 *
 * `ponytail:` the caller hands us the *whole* body, already bounded by
 * `readBoundedUtf8`, so there is no incremental reader and no live progress here —
 * this trades incremental display for not owning a streaming state machine. The
 * ceiling and abortability the transport needs are unchanged. Upgrade path: drive
 * this same assembler from a `for await` loop if live output is ever wanted.
 *
 * A stream that ends without `[DONE]` **and** without any `finish_reason` was cut
 * mid-flight, and is refused rather than accepted as a short answer.
 */
export function parseSseCompletion(raw: string): unknown {
  let model: unknown;
  let content = "";
  let reasoning = "";
  let finishReason: unknown;
  let usage: unknown;
  let sawDone = false;
  const calls = new Map<number, { id: unknown; type: unknown; name: string; args: string }>();
  let events = 0;

  for (const line of raw.split("\n")) {
    if (!line.startsWith("data:")) continue;
    const payload = line.slice(5).trim();
    if (payload === "[DONE]") { sawDone = true; break; }
    if (payload === "") continue;
    let event: unknown;
    try { event = JSON.parse(payload); }
    catch { throw new Error("model returned a malformed SSE event (原始分片已隐藏)"); }
    const chunk = record(event, "sse chunk");
    events += 1;
    if (chunk.model !== undefined && model === undefined) model = chunk.model;
    // Every chunk carries a `usage` key, almost always null; the real one arrives in
    // a final chunk with no choices. Keeping the last non-null is what makes token
    // accounting survive streaming.
    if (chunk.usage !== undefined && chunk.usage !== null) usage = chunk.usage;
    if (!Array.isArray(chunk.choices) || chunk.choices.length === 0) continue;
    const choice = record(chunk.choices[0], "sse choice");
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) finishReason = choice.finish_reason;
    const delta = record(choice.delta ?? {}, "sse delta");
    if (typeof delta.content === "string") content += delta.content;
    else if (delta.content !== undefined && delta.content !== null) throw new Error("invalid model response: content");
    if (typeof delta.reasoning_content === "string") reasoning += delta.reasoning_content;
    else if (delta.reasoning_content !== undefined && delta.reasoning_content !== null) throw new Error("invalid model response: reasoning_content");
    if (delta.tool_calls === undefined || delta.tool_calls === null) continue;
    if (!Array.isArray(delta.tool_calls)) throw new Error("invalid model response: tool_calls");
    for (const rawCall of delta.tool_calls) {
      const call = record(rawCall, "sse tool call");
      const index = call.index === undefined ? 0 : tokenCount(call.index);
      // `id` and `name` may arrive only in the first fragment while `arguments`
      // streams in pieces, so name and arguments are appended — spec-correct, and
      // identical in effect to the single-fragment call this project's live endpoint
      // sends.
      const entry = calls.get(index) ?? { id: undefined, type: undefined, name: "", args: "" };
      if (call.id !== undefined && call.id !== null && entry.id === undefined) entry.id = call.id;
      if (call.type !== undefined && call.type !== null && entry.type === undefined) entry.type = call.type;
      const fn = record(call.function ?? {}, "sse function");
      if (typeof fn.name === "string") entry.name += fn.name;
      else if (fn.name !== undefined && fn.name !== null) throw new Error("invalid model response: tool name");
      if (typeof fn.arguments === "string") entry.args += fn.arguments;
      else if (fn.arguments !== undefined && fn.arguments !== null) throw new Error("invalid model response: tool arguments");
      calls.set(index, entry);
    }
  }

  if (events === 0) throw new Error("model returned an empty SSE stream");
  if (!sawDone && finishReason === undefined) {
    throw new Error("model stream ended early: no [DONE] and no finish_reason (未完成回复未保存)");
  }
  const message: Record<string, unknown> = { role: "assistant", content };
  if (reasoning !== "") message.reasoning_content = reasoning;
  if (calls.size > 0) {
    message.tool_calls = [...calls.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, call]) => ({ id: call.id, type: call.type ?? "function",
        function: { name: call.name, arguments: call.args } }));
  }
  return {
    ...(model === undefined ? {} : { model }),
    choices: [{ index: 0, ...(finishReason === undefined ? {} : { finish_reason: finishReason }), message }],
    ...(usage === undefined ? {} : { usage }),
  };
}

/**
 * OpenAI-compatible chat adapter (`POST {baseUrl}/chat/completions`).
 *
 * Works with the OpenAI API and with any server that speaks the same shape
 * (vLLM, llama.cpp server, LM Studio, Ollama's OpenAI endpoint), which is what
 * makes the provider replaceable without touching the runtime.
 */
export function createOpenAIChatAdapter(options: OpenAIChatAdapterOptions): ModelAdapter {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? 120_000;

  return {
    id: "openai-chat",
    defaultModel: options.model,
    async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
      const timeout = AbortSignal.timeout(timeoutMs);
      const composed = signal ? AbortSignal.any([signal, timeout]) : timeout;

      const response = await doFetch(`${options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model ?? options.model,
          messages: request.messages.map(toWireMessage),
          ...(request.tools && request.tools.length > 0
            ? {
                tools: request.tools.map((tool) => ({
                  type: "function",
                  function: {
                    name: tool.name,
                    description: tool.description,
                    parameters: tool.parameters,
                  },
                })),
              }
            : {}),
          ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
          // Only on the streaming path: a server that rejects unknown body fields
          // must still accept the default request.
          ...(options.stream ? { stream: true, stream_options: { include_usage: true } } : {}),
        }),
        signal: composed,
      });

      if (!response.ok) {
        await response.body?.cancel();
        throw new Error(`model request failed: HTTP ${response.status} (检查服务地址、模型和密钥)`);
      }

      // Read as text first: a 200 with an HTML error page or an empty body is a
      // real failure mode behind proxies, and `response.json()` would surface it
      // as an opaque SyntaxError with no hint of what the server actually sent.
      // The read is bounded by bytes actually received, so a content-length that
      // understates the body cannot get past the ceiling.
      const raw = response.body === null
        ? ""
        : await readBoundedUtf8(response.body, CHAT_RESPONSE_MAX_BYTES, "model response");
      // On the streaming path `parseSseCompletion` raises its own named errors, so
      // only the non-streaming body goes through the JSON catch.
      let decoded: unknown;
      if (options.stream) decoded = parseSseCompletion(raw);
      else {
        try { decoded = JSON.parse(raw); }
        catch { throw new Error("model returned a non-JSON body (原始响应已隐藏)"); }
      }
      const payload = record(decoded, "payload");
      if (!Array.isArray(payload.choices) || !payload.choices.length) throw new Error("invalid model response: choices");
      const choice = record(payload.choices[0], "choice");
      // Some compatible endpoints omit finish_reason; reject explicit incomplete endings.
      if (choice.finish_reason === "length" || choice.finish_reason === "content_filter") {
        throw new Error(`model response incomplete: ${choice.finish_reason} (回复未完成，未保存或执行其中的工具调用)`);
      }
      const message = record(choice.message, "message");
      const calls = message.tool_calls ?? [];
      if (!Array.isArray(calls)) throw new Error("invalid model response: tool_calls");
      const toolCalls = calls.map(rawCall => {
        const call = record(rawCall, "tool call");
        const fn = record(call.function, "function");
        if (call.type !== undefined && call.type !== "function") throw new Error("invalid model response: tool type");
        return { id: call.id, name: fn.name, arguments: fn.arguments };
      });
      const usage = payload.usage === undefined ? {} : record(payload.usage, "usage");
      // Two provider-specific names, both optional and both taken only as reported:
      // the reasoning trace (`reasoning_content`, the DeepSeek-style field this
      // project's live endpoint emits) and the reasoning share of the output count
      // (`completion_tokens_details.reasoning_tokens`). Neither is invented when
      // absent — a model with no reasoning trace simply reports none.
      const reasoning = readReasoning(message.reasoning_content);
      const details = usage.completion_tokens_details === undefined || usage.completion_tokens_details === null
        ? undefined
        : record(usage.completion_tokens_details, "usage.completion_tokens_details");
      const reasoningTokens = details?.reasoning_tokens === undefined || details.reasoning_tokens === null
        ? undefined
        : tokenCount(details.reasoning_tokens);
      const result = { content: message.content === null || message.content === undefined ? "" : message.content,
        ...(reasoning === undefined ? {} : { reasoning }),
        model: payload.model ?? request.model ?? options.model, toolCalls,
        usage: { inputTokens: tokenCount(usage.prompt_tokens ?? 0), outputTokens: tokenCount(usage.completion_tokens ?? 0),
          ...(reasoningTokens === undefined ? {} : { reasoningTokens }) } };
      validateResponse(result);
      return result;
    },
  };
}
