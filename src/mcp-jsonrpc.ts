/**
 * JSON-RPC 2.0 encoding/decoding for the MCP stdio transport (M4 路 C, 丙-1).
 *
 * The bottom, process-free layer of the MCP client. It turns messages into bytes
 * and bytes back into messages, and pairs a response to the request that asked
 * for it. It spawns nothing — that is 丙-2 — so it is entirely unit-testable
 * against strings.
 *
 * **Framing.** MCP's stdio transport is newline-delimited JSON: each JSON-RPC
 * message is one line, terminated by `\n`, with no embedded newlines (JSON
 * encoders never emit a raw newline inside a value). This is the framing both
 * reference implementations we read use for stdio — codex's rmcp client and DSH's
 * `dsh-mcp-client` both drive a stdio child over line-delimited JSON-RPC
 * (`REFERENCE_DECISIONS.md` §12.5). We do not implement the HTTP/SSE transport
 * here; 路 C starts with stdio because that is the local-subprocess case.
 *
 * **Zero dependencies.** The MCP SDK is not vendored — this project ships no
 * production dependencies — so the wire format is implemented directly. It is
 * small: request/response/notification, an id counter, and a pending-call map.
 *
 * ponytail: no batch requests (MCP does not use them over stdio), no positional
 * params, no JSON-RPC 1.0 fallback. The ceiling is exactly the three message
 * shapes MCP sends and receives.
 */

/** The JSON-RPC version string every message must carry. */
export const JSONRPC_VERSION = "2.0";

/** A request: has an id, expects a response. */
export interface JsonRpcRequest {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: number;
  readonly method: string;
  readonly params?: unknown;
}

/** A notification: no id, no response. */
export interface JsonRpcNotification {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly method: string;
  readonly params?: unknown;
}

/** A JSON-RPC error object, as it appears inside a response. */
export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: unknown;
}

/** A response: carries the id it answers, and exactly one of result/error. */
export interface JsonRpcResponse {
  readonly jsonrpc: typeof JSONRPC_VERSION;
  readonly id: number;
  readonly result?: unknown;
  readonly error?: JsonRpcError;
}

/** Any inbound message, before we know which kind it is. */
export type JsonRpcInbound = JsonRpcResponse | JsonRpcNotification;

/** Encode one message as a single newline-terminated line. */
export function encodeMessage(message: JsonRpcRequest | JsonRpcNotification): string {
  return JSON.stringify(message) + "\n";
}

/**
 * Split a growing buffer into complete lines, returning the parsed messages and
 * the unconsumed remainder.
 *
 * Framing is done here rather than in the client so the client never sees a
 * partial line. A line that is only whitespace is skipped (some servers emit a
 * blank keep-alive line); a line that is not valid JSON throws, because a stdio
 * server that emits garbage on the protocol channel is a fault, not something to
 * silently drop — the same "corrupt means refused" stance the rest of this
 * project takes.
 */
export function drainMessages(buffer: string): { readonly messages: readonly JsonRpcInbound[]; readonly rest: string } {
  const messages: JsonRpcInbound[] = [];
  let rest = buffer;
  while (true) {
    const newline = rest.indexOf("\n");
    if (newline === -1) break;
    const line = rest.slice(0, newline);
    rest = rest.slice(newline + 1);
    if (line.trim() === "") continue;
    messages.push(parseInbound(line));
  }
  return { messages, rest };
}

/**
 * Parse one line into a response or a notification, refusing anything that does
 * not match a shape MCP sends. A request from the server (sampling/roots) is a
 * feature this client does not offer, so an inbound message carrying both an id
 * and a method is refused rather than misread as a response.
 */
export function parseInbound(line: string): JsonRpcInbound {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error(`MCP server 发来的不是合法 JSON：${truncate(line)}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`MCP 消息必须是一个对象：${truncate(line)}`);
  }
  const record = parsed as Record<string, unknown>;
  if (record.jsonrpc !== JSONRPC_VERSION) {
    throw new Error(`MCP 消息缺少或错误的 jsonrpc 版本（应为 "${JSONRPC_VERSION}"）：${truncate(line)}`);
  }
  const hasId = "id" in record && record.id !== null;
  const hasMethod = "method" in record;
  if (hasId && hasMethod) {
    // A server-to-client request. This client offers no such capability, so it is
    // refused rather than mistaken for a response.
    throw new Error(`本 MCP 客户端不支持服务器发起的请求（method ${JSON.stringify(record.method)}）`);
  }
  if (hasMethod) {
    if (typeof record.method !== "string") throw new Error(`MCP 通知的 method 必须是字符串：${truncate(line)}`);
    return record.params === undefined
      ? { jsonrpc: JSONRPC_VERSION, method: record.method }
      : { jsonrpc: JSONRPC_VERSION, method: record.method, params: record.params };
  }
  if (!hasId) {
    throw new Error(`MCP 响应缺少 id：${truncate(line)}`);
  }
  if (typeof record.id !== "number" || !Number.isSafeInteger(record.id)) {
    throw new Error(`MCP 响应的 id 必须是安全整数：${truncate(line)}`);
  }
  const hasResult = "result" in record;
  const hasError = "error" in record;
  if (hasResult === hasError) {
    throw new Error(`MCP 响应必须恰好有 result 或 error 之一：${truncate(line)}`);
  }
  if (hasError) {
    const error = parseError(record.error, line);
    return { jsonrpc: JSONRPC_VERSION, id: record.id, error };
  }
  return { jsonrpc: JSONRPC_VERSION, id: record.id, result: record.result };
}

function parseError(value: unknown, line: string): JsonRpcError {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`MCP 错误对象格式不对：${truncate(line)}`);
  }
  const record = value as Record<string, unknown>;
  if (typeof record.code !== "number" || !Number.isSafeInteger(record.code)) {
    throw new Error(`MCP 错误缺少整数 code：${truncate(line)}`);
  }
  if (typeof record.message !== "string") {
    throw new Error(`MCP 错误缺少字符串 message：${truncate(line)}`);
  }
  return record.data === undefined
    ? { code: record.code, message: record.message }
    : { code: record.code, message: record.message, data: record.data };
}

function truncate(line: string): string {
  return line.length > 200 ? line.slice(0, 200) + "…" : line;
}

/**
 * Pairs outbound requests with the responses that answer them.
 *
 * Owns the id counter (ids are monotonic per connection) and the pending map.
 * `next` builds a request and remembers who is waiting; `settle` resolves the
 * waiter for an inbound response and returns whether it matched a pending call.
 * An unknown id is reported to the caller (it decides whether to log or throw),
 * because a response to an id we never sent is a server fault, not a normal case.
 *
 * This class has no timers and no I/O — the client (丙-2) attaches those. Keeping
 * it pure is what lets the whole pairing protocol be tested without a process.
 */
export class RequestPairing {
  #nextId = 1;
  readonly #pending = new Map<number, { resolve(result: unknown): void; reject(error: Error): void }>();

  /** Build the next request and register its waiter. */
  next(method: string, params: unknown): { readonly request: JsonRpcRequest; readonly response: Promise<unknown> } {
    const id = this.#nextId++;
    const request: JsonRpcRequest =
      params === undefined
        ? { jsonrpc: JSONRPC_VERSION, id, method }
        : { jsonrpc: JSONRPC_VERSION, id, method, params };
    const response = new Promise<unknown>((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
    });
    return { request, response };
  }

  /** Resolve or reject the waiter for a response. Returns false if the id is unknown. */
  settle(response: JsonRpcResponse): boolean {
    const waiter = this.#pending.get(response.id);
    if (!waiter) return false;
    this.#pending.delete(response.id);
    if (response.error) {
      waiter.reject(new Error(`MCP 服务器返回错误 ${response.error.code}：${response.error.message}`));
    } else {
      waiter.resolve(response.result);
    }
    return true;
  }

  /** Reject every outstanding call — used when the connection dies. */
  rejectAll(reason: string): void {
    for (const waiter of this.#pending.values()) waiter.reject(new Error(reason));
    this.#pending.clear();
  }

  /** How many calls are still awaiting a response. */
  get pendingCount(): number {
    return this.#pending.size;
  }
}
