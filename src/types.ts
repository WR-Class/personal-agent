/**
 * Core message, tool and model contracts.
 *
 * The runtime only ever talks to a {@link ModelAdapter}; the concrete provider
 * (OpenAI-compatible HTTP, a local server, or the offline mock) is chosen at
 * the edge, so swapping models never touches the loop.
 *
 * Tool-calling uses the OpenAI function-calling shape verbatim, because the
 * HTTP adapter already speaks that dialect. Inventing a private protocol would
 * only add a translation layer that can drift from the wire format.
 */

export type Role = "system" | "user" | "assistant" | "tool";

/** A tool invocation requested by the model. Arguments stay raw text. */
export interface ToolCall {
  id: string;
  name: string;
  /**
   * The model's arguments as it emitted them. Kept as a string rather than a
   * parsed object so invalid JSON is preserved for the tool to reject loudly
   * instead of being silently coerced into `{}`.
   */
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Assistant messages only: the calls this turn requested. */
  toolCalls?: ToolCall[];
  /** Tool messages only: the call this message answers. */
  toolCallId?: string;
}

/** JSON Schema subset describing a tool's parameters. */
export interface JsonSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** A tool as advertised to the model. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Tools offered for this turn; omitted when the caller runs without tools. */
  tools?: ToolDefinition[];
  /** Adapter-specific model id; falls back to the adapter's configured default. */
  model?: string;
  temperature?: number;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Provider-reported share of {@link outputTokens} spent on the model's private
   * reasoning, when the provider reports it (e.g. `completion_tokens_details.
   * reasoning_tokens`). It is a *subset* marker for explaining a large output
   * count, never added on top: this project reports the number the provider gave
   * and does not independently verify the subset relation.
   */
  reasoningTokens?: number;
}

export interface ChatResponse {
  content: string;
  /**
   * The model's reasoning trace, when the provider exposes one (`reasoning_content`
   * on the wire). Deliberately NOT part of {@link ChatMessage}: reasoning is
   * derived, verbose, and never replayed, so keeping it off the message type makes
   * "it is not persisted and not sent back" a property of the shape rather than a
   * rule someone has to remember.
   */
  reasoning?: string;
  /** Calls the model wants executed before it can continue. */
  toolCalls: ToolCall[];
  model: string;
  usage: ChatUsage;
}

/** Every model provider implements exactly this. */
export interface ModelAdapter {
  readonly id: string;
  readonly defaultModel: string;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
}
