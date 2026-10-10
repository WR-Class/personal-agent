import type { ChatMessage, ChatRequest, ChatResponse, ModelAdapter } from "./types.ts";

export interface StreamProgress { bytes:number; textChars:number; reasoningChars:number; toolChars:number; lastDataAt:number; }

/**
 * Shape of a reply that ended before it was complete (`finish_reason: length`/`content_filter`).
 * The counters are the reply's own, so a caller can tell a cutoff that spent everything on
 * reasoning — which a thinking-disabled resume can still finish — from a partial answer that
 * nobody may use. Attached to the thrown error; absent means "not this kind of failure".
 */
export interface IncompleteReply { reason:string; textChars:number; reasoningChars:number; toolArgsChars:number; }

export function incompleteReply(error:unknown):IncompleteReply|undefined {
  const value=(error as {incomplete?:unknown}|null)?.incomplete;
  if(!value||typeof value!=='object')return undefined;
  const info=value as Record<string,unknown>;
  return typeof info.reason==='string'&&typeof info.textChars==='number'&&typeof info.reasoningChars==='number'&&typeof info.toolArgsChars==='number'
    ? {reason:info.reason,textChars:info.textChars,reasoningChars:info.reasoningChars,toolArgsChars:info.toolArgsChars}
    : undefined;
}

export interface OpenAIChatAdapterOptions {
  /** Base URL including the version segment, e.g. https://api.openai.com/v1 */
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  firstDataTimeoutMs?: number;
  idleTimeoutMs?: number;
  onProgress?: (progress:StreamProgress)=>void;
  /** Host-only diagnostics; never includes payloads, credentials or provider error text. */
  onPhase?: (phase: 'headers' | 'body' | 'decode' | 'complete') => void;
  /**
   * Upper bound on tokens the provider may generate for one response.
   *
   * Sent on every request, and defaulted rather than omitted. Two reasons, and
   * the second is the one that forced it: the project's rule everywhere else is
   * that the caller declares the ceiling (write budget, byte limits, deadline),
   * and observed against a local gateway the field is not optional in practice —
   * the *same* request returns 200 with it and 502 without it, reproduced twice
   * one parameter apart. A request shape a gateway rejects some of the time is a
   * defect, not an environment quirk, so the value is always sent.
   */
  maxTokens?: number;
  /** Explicit opt-in for DeepSeek-compatible Chat endpoints only. */
  thinkingDisabled?: boolean;
  /**
   * Ask the provider to stream (`stream: true`) and assemble the SSE transcript
   * back into the ordinary {@link ChatResponse}.
   *
   * Off by default, because it changes the request body: this project only sends
   * `stream_options.include_usage` on this path, and a server that rejects unknown
   * fields should not have to reject the default path too. What streaming buys here
   * is compatibility (endpoints that only stream now work) plus the same byte
   * ceiling and abortability as the non-streaming path. onText delivers tentative
   * previews; final validation still gates persistence and tool execution.
   */
  stream?: boolean;
  /** Tentative visible text only; never authorizes tool execution or persistence. */
  onText?: (text: string) => void;
  /** Provider-supplied preview only, never executable tool arguments. */
  onProcess?: (event:{reasoning?:string;tool?:{index:number;name:string;argumentChars:number}})=>void;
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
// SSE repeats JSON metadata per token; wire bytes are not generated text bytes.
export const SSE_RESPONSE_MAX_BYTES = 32 * 1024 * 1024;

/**
 * Default ceiling on generated tokens per response.
 *
 * Deliberately generous enough not to truncate ordinary work, and deliberately
 * finite. The point is not the number but that a request always declares one:
 * see {@link OpenAIChatAdapterOptions.maxTokens} for the gateway that returns
 * 502 when the field is absent.
 */
export const DEFAULT_MAX_TOKENS = 8192;

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
 * Incremental previews are tentative; this bounded transcript remains the
 * authoritative input for final validation, usage and assembled tool arguments.
 *
 * A stream that ends without `[DONE]` **and** without any `finish_reason` was cut
 * mid-flight, and is refused rather than accepted as a short answer.
 */
async function readStreamPreview(source: AsyncIterable<Uint8Array>, onText?: (text:string)=>void, onProgress?:(p:StreamProgress)=>void, onProcess?:OpenAIChatAdapterOptions['onProcess']): Promise<string> {
  const decoder = new TextDecoder(); let raw='', pending='', total=0, done=false;
  const progress:StreamProgress={bytes:0,textChars:0,reasoningChars:0,toolChars:0,lastDataAt:0};
  const previews=new Map<number,{index:number;name:string;argumentChars:number}>();
  function line(value:string) {
    if(done || !value.startsWith('data:'))return;
    const data=value.slice(5).trim(); if(!data)return;
    if(data==='[DONE]'){done=true;return;}
    let event;try{event=JSON.parse(data);}catch{throw new Error('model returned a malformed SSE event (原始分片已隐藏)');}
    const chunk=record(event,'sse chunk');
    if(chunk.error)throw new Error('model stream ended with an upstream error (原始错误已隐藏)');
    if(!Array.isArray(chunk.choices)||!chunk.choices.length)return;
    const delta=record(record(chunk.choices[0],'sse choice').delta??{},'sse delta');
    const text=delta.content;
    if(typeof text==='string' && text){progress.textChars+=text.length;onText?.(text);}
    if(typeof delta.reasoning_content==='string'){progress.reasoningChars+=delta.reasoning_content.length;onProcess?.({reasoning:delta.reasoning_content});}
    if(Array.isArray(delta.tool_calls))for(const call of delta.tool_calls){
      const index=tokenCount(call?.index??0),args=call?.function?.arguments;
      const tool=previews.get(index)??{index,name:'',argumentChars:0};
      if(typeof call?.function?.name==='string')tool.name=(tool.name+call.function.name).slice(0,128);
      if(typeof args==='string'){progress.toolChars+=args.length;tool.argumentChars+=args.length;}
      previews.set(index,tool);onProcess?.({tool:{...tool}});
    }
  }
  for await(const bytes of source){
    total+=bytes.byteLength;if(total>SSE_RESPONSE_MAX_BYTES)throw new Error(`model response exceeds the ${SSE_RESPONSE_MAX_BYTES}-byte limit`);
    const text=decoder.decode(bytes,{stream:true});raw+=text;pending+=text;
    let end;while((end=pending.indexOf('\n'))>=0){line(pending.slice(0,end));pending=pending.slice(end+1);}
    if(bytes.byteLength){progress.bytes=total;progress.lastDataAt=Date.now();onProgress?.({...progress});}
    if(done)break; // DONE terminates SSE even when a proxy leaves its socket open.
  }
  const tail=decoder.decode();raw+=tail;pending+=tail;if(pending&&!done)line(pending);
  return raw;
}

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
    if(chunk.error)throw new Error('model stream ended with an upstream error (原始错误已隐藏)');
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
  const maxTokens = options.maxTokens ?? DEFAULT_MAX_TOKENS;

  /**
   * `doFetch`, with the transport reason surfaced.
   *
   * `fetch` reports every transport failure as one opaque `TypeError: fetch failed` and
   * keeps the actual reason in `cause` — `bad port` when the provider URL uses a port
   * fetch refuses to touch at all (the WHATWG bad-port list; this project's own test
   * servers were bitten by it), `ECONNREFUSED` when nothing is listening, a DNS or TLS
   * message otherwise. Reporting only the outer message leaves the operator with
   * nothing to act on, so the cause is appended when it says something new.
   *
   * An aborted request is re-thrown untouched: the abort is the caller's own signal,
   * and rewriting it would stop the runtime telling a cancelled turn from a failed one.
   */
  async function sendRequest(url: string, init: RequestInit & { signal: AbortSignal }): Promise<Response> {
    try { return await doFetch(url, init); }
    catch (error) {
      if (init.signal.aborted) throw error;
      const cause = (error as { cause?: unknown }).cause;
      const detail = cause instanceof Error ? cause.message : undefined;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(detail && detail !== message ? `${message}: ${detail}` : message);
    }
  }

  return {
    id: "openai-chat",
    defaultModel: options.model,
    async chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse> {
      const timeout = AbortSignal.timeout(timeoutMs);
      const activityController=new AbortController();
      const composed = AbortSignal.any([...(signal?[signal]:[]),timeout,activityController.signal]);
      let activityTimer:ReturnType<typeof setTimeout>|undefined;
      function arm(ms:number|undefined,name:string){
        clearTimeout(activityTimer);if(ms===undefined)return;
        if(!Number.isSafeInteger(ms)||ms<1)throw new Error('invalid transport timeout');
        activityTimer=setTimeout(()=>activityController.abort(new DOMException(name,name)),ms);
      }
      arm(options.firstDataTimeoutMs,'FirstDataTimeoutError');
      async function* watch(source:AsyncIterable<Uint8Array>){for await(const bytes of source){if(bytes.byteLength)arm(options.idleTimeoutMs,'StreamIdleTimeoutError');yield bytes;}}
      try {
      const requestStarted = performance.now();
      options.onPhase?.('headers');
      const response = await sendRequest(`${options.baseUrl.replace(/\/+$/, "")}/chat/completions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify({
          model: request.model ?? options.model,
          messages: request.messages.map(toWireMessage),
          // Always present, never omitted: the caller declares the ceiling, and
          // this gateway rejects the request outright without it.
          max_tokens: maxTokens,
          ...(options.thinkingDisabled===true?{thinking:{type:'disabled'}}:{}),
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

      options.onPhase?.('body');
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
        : options.stream ? await readStreamPreview(watch(response.body),options.onText,options.onProgress,options.onProcess)
        : await readBoundedUtf8(watch(response.body), CHAT_RESPONSE_MAX_BYTES, "model response");
      clearTimeout(activityTimer);
      const durationMs = performance.now() - requestStarted;
      options.onPhase?.('decode');
      // On the streaming path `parseSseCompletion` raises its own named errors, so
      // only the non-streaming body goes through the JSON catch.
      let decoded: unknown;
      // Some compatible gateways ignore stream:true and return a complete JSON reply.
      if (options.stream && !raw.trimStart().startsWith('{')) decoded = parseSseCompletion(raw);
      else {
        if(Buffer.byteLength(raw)>CHAT_RESPONSE_MAX_BYTES)throw new Error(`model response exceeds the ${CHAT_RESPONSE_MAX_BYTES}-byte limit`);
        try { decoded = JSON.parse(raw); }
        catch { throw new Error("model returned a non-JSON body (原始响应已隐藏)"); }
      }
      const payload = record(decoded, "payload");
      if (!Array.isArray(payload.choices) || !payload.choices.length) throw new Error("invalid model response: choices");
      const choice = record(payload.choices[0], "choice");
      // Some compatible endpoints omit finish_reason; reject explicit incomplete endings.
      if (choice.finish_reason === "length" || choice.finish_reason === "content_filter") {
        const partial = (choice.message ?? {}) as { content?: unknown; reasoning_content?: unknown; tool_calls?: unknown };
        const chars = (value: unknown) => typeof value === "string" ? value.length : 0;
        const args = Array.isArray(partial.tool_calls)
          ? partial.tool_calls.reduce<number>((total, call) => total + chars((call as { function?: { arguments?: unknown } } | null)?.function?.arguments), 0)
          : 0;
        const error = new Error(`model response incomplete: ${choice.finish_reason} (回复未完成，未保存或执行其中的工具调用)`) as Error & { incomplete?: IncompleteReply };
        error.incomplete = { reason: String(choice.finish_reason), textChars: chars(partial.content), reasoningChars: chars(partial.reasoning_content), toolArgsChars: args };
        throw error;
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
      const promptDetails = usage.prompt_tokens_details == null ? undefined : record(usage.prompt_tokens_details, "usage.prompt_tokens_details");
      const cached = promptDetails?.cached_tokens ?? usage.prompt_cache_hit_tokens;
      const cachedInputTokens = cached == null ? undefined : tokenCount(cached);
      const result = { content: message.content === null || message.content === undefined ? "" : message.content,
        ...(reasoning === undefined ? {} : { reasoning }),
        model: payload.model ?? request.model ?? options.model, toolCalls,
        usage: { inputTokens: tokenCount(usage.prompt_tokens ?? 0), outputTokens: tokenCount(usage.completion_tokens ?? 0),
          reported: typeof usage.prompt_tokens === 'number' && typeof usage.completion_tokens === 'number', durationMs,
          ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
          ...(reasoningTokens === undefined ? {} : { reasoningTokens }) } };
      validateResponse(result);
      options.onPhase?.('complete');
      return result;
      } catch(error){
        if(signal?.aborted)throw signal.reason;
        if(timeout.aborted)throw timeout.reason;
        if(activityController.signal.aborted)throw activityController.signal.reason;
        throw error;
      } finally {clearTimeout(activityTimer);}
    },
  };
}
