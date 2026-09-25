import type { ChatRequest, ChatResponse, ChatUsage, ModelAdapter, ToolCall } from "./types.ts";

/**
 * Offline model adapter: deterministic, no network, no credentials.
 *
 * It echoes the last user message so tests can assert the loop end to end
 * without a provider. Kept in `src/` (not `test/`) because it is also the
 * fallback adapter a user can point the CLI at before configuring a key.
 *
 * It never requests a tool, which is what makes it a useful baseline: a turn
 * that finishes in exactly one step.
 */
export function createEchoAdapter(options?: { id?: string; model?: string }): ModelAdapter {
  const id = options?.id ?? "echo";
  const defaultModel = options?.model ?? "echo-1";

  return {
    id,
    defaultModel,
    async chat(request: ChatRequest): Promise<ChatResponse> {
      const last = [...request.messages].reverse().find((message) => message.role === "user");
      const content = last ? `echo: ${last.content}` : "echo: (no user message)";
      const inputChars = request.messages.reduce((total, message) => total + message.content.length, 0);
      return {
        content,
        toolCalls: [],
        model: request.model ?? defaultModel,
        usage: {
          inputTokens: Math.ceil(inputChars / 4),
          outputTokens: Math.ceil(content.length / 4),
        },
      };
    },
  };
}

/** One scripted model reply, in order. */
export type ScriptedStep =
  | { content: string; reasoning?: string; toolCalls?: ToolCall[]; usage?: ChatUsage }
  | { toolCalls: ToolCall[]; reasoning?: string; usage?: ChatUsage };

export interface ScriptedAdapterOptions {
  steps: ScriptedStep[];
  id?: string;
  model?: string;
}

/**
 * A model that replays a fixed script, for driving the tool loop offline.
 *
 * Real tool loops are hard to test against a live model because a provider will
 * not reliably emit the exact call sequence a test needs. Scripting the replies
 * makes the loop's own behaviour — step counting, ordering, what it does when
 * the model keeps asking — the thing under test.
 *
 * Requests are recorded on {@link ScriptedAdapter.requests} so a test can assert
 * what the loop actually sent, which is how prompt reconstruction gets checked
 * rather than assumed.
 */
export interface ScriptedAdapter extends ModelAdapter {
  readonly requests: ChatRequest[];
  /** Script entries consumed so far. */
  readonly consumed: number;
}

export function createScriptedAdapter(options: ScriptedAdapterOptions): ScriptedAdapter {
  const id = options.id ?? "scripted";
  const defaultModel = options.model ?? "scripted-1";
  const requests: ChatRequest[] = [];
  let cursor = 0;

  return {
    id,
    defaultModel,
    requests,
    get consumed(): number {
      return cursor;
    },
    async chat(request: ChatRequest): Promise<ChatResponse> {
      requests.push(request);
      const step = options.steps[cursor];
      cursor += 1;
      if (!step) {
        throw new Error(`scripted adapter ran out of steps after ${options.steps.length} replies`);
      }
      const toolCalls = "toolCalls" in step ? step.toolCalls ?? [] : [];
      const content = "content" in step ? step.content : "";
      const reasoning = "reasoning" in step ? step.reasoning : undefined;
      return {
        content,
        ...(reasoning === undefined ? {} : { reasoning }),
        toolCalls,
        model: request.model ?? defaultModel,
        // Scripted usage defaults to a flat 1/1; a step may report real numbers so
        // budgets that key off the provider's own count can be exercised.
        usage: step.usage ?? { inputTokens: 1, outputTokens: 1 },
      };
    },
  };
}
