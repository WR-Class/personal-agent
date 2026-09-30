/**
 * MCP client over a stdio subprocess (M4 路 C, 丙-2).
 *
 * The layer that turns the pure protocol (丙-1, `mcp-jsonrpc.ts`) into a live
 * connection: it spawns the server as a child process, pumps its stdout through
 * the framing/pairing machinery, sends requests with a timeout, does the MCP
 * `initialize` handshake, and shuts the child down without leaving orphans.
 *
 * **The server code never runs in our process.** This is the whole point of 路 C
 * and the reason all five products the investigation read chose it
 * (`REFERENCE_DECISIONS.md` §12.5): the third-party tool code lives in its own
 * process, and we speak JSON-RPC to it over stdin/stdout. We spawn it, name it,
 * time it out, and kill it — we do not link it.
 *
 * **Process discipline is borrowed from `background-jobs.ts`, deliberately:**
 * - The child is **not detached** — attached to our process tree so cleanup
 *   depends on the parent relationship, not on finding a stray pid later.
 * - `shell: false`, `windowsHide: true`, explicit `stdio` — no interposed shell,
 *   which is what created orphans and quoting bugs there.
 * - Shutdown kills the **whole tree**: on Windows `child.kill()` leaves
 *   grandchildren running (measured in background-jobs.ts:216-236), so
 *   `taskkill /T /F` is used, with a direct-kill fallback.
 *
 * The kill logic is inlined rather than shared with `background-jobs.ts`: the two
 * differ in what they hold (a JobRecord vs a live child), and this is only the
 * second user. If a third appears, extract `killProcessTree(pid, child)` then —
 * not now (YAGNI).
 *
 * **The environment is the already-scrubbed `ToolEnvironment`.** `buildToolEnvironment`
 * allowlists a handful of variables and redirects HOME/TMP into the agent home, so
 * the server child does not inherit the operator's secrets. This is the same
 * "environment scrubbing (stdio)" DSH does before spawning an MCP child; we get it
 * for free because tools already run under this environment.
 *
 * ponytail: no HTTP/SSE transport (stdio is the local-subprocess case 路 C starts
 * with), no reconnect/backoff (a server that dies fails its calls; restart policy
 * is a later concern if it proves needed), no server-initiated requests (the
 * protocol layer already refuses them).
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import {
  RequestPairing,
  drainMessages,
  encodeMessage,
  type JsonRpcNotification,
  type JsonRpcResponse,
} from "./mcp-jsonrpc.ts";
import type { ToolEnvironment } from "./tool-environment.ts";

/** How the MCP server is launched: a program and its arguments. */
export interface McpServerSpec {
  readonly command: string;
  readonly args?: readonly string[];
}

/** Default per-request timeout. A server that does not answer must not hang a turn. */
export const MCP_REQUEST_TIMEOUT_MS = 30_000;

/** The protocol version this client declares in `initialize`. */
export const MCP_PROTOCOL_VERSION = "2025-06-18";

/** What `initialize` returns, narrowed to what we use. */
export interface McpInitializeResult {
  readonly protocolVersion?: string;
  readonly serverInfo?: { readonly name?: string; readonly version?: string };
  readonly capabilities?: Record<string, unknown>;
}

/**
 * A live connection to one MCP server subprocess.
 *
 * Construct with {@link startMcpClient}, which spawns and hands back a started
 * client; call {@link McpClient.initialize} once, then {@link McpClient.request}
 * per call, then {@link McpClient.close} to stop the child.
 */
export class McpClient {
  readonly #child: ChildProcessWithoutNullStreams;
  readonly #pairing = new RequestPairing();
  #buffer = "";
  #closed = false;
  readonly #notifications: JsonRpcNotification[] = [];
  readonly #timeoutMs: number;

  constructor(child: ChildProcessWithoutNullStreams, timeoutMs: number) {
    this.#child = child;
    this.#timeoutMs = timeoutMs;

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => this.#onData(chunk));
    // stderr is the server's diagnostic channel, never the protocol channel. It is
    // drained so the pipe never fills and blocks the child, but not parsed.
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", () => {});
    child.on("close", () => this.#onClose("MCP 服务器进程已退出"));
    child.on("error", (error) => this.#onClose(`MCP 服务器进程启动失败：${error.message}`));
  }

  #onData(chunk: string): void {
    this.#buffer += chunk;
    let drained;
    try {
      drained = drainMessages(this.#buffer);
    } catch (error) {
      // A malformed protocol line is a fault: fail every pending call and close,
      // rather than letting a broken server hang the turn.
      this.#onClose(`MCP 协议错误：${(error as Error).message}`);
      return;
    }
    this.#buffer = drained.rest;
    for (const message of drained.messages) {
      if ("method" in message) {
        this.#notifications.push(message);
        continue;
      }
      // A response to an id we never sent is a server fault; drop it rather than
      // throw, because throwing here would tear down a connection over the
      // server's mistake. settle returns false in that case.
      this.#pairing.settle(message as JsonRpcResponse);
    }
  }

  #onClose(reason: string): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#pairing.rejectAll(reason);
  }

  /** Notifications the server sent, in order. Read-only view. */
  get notifications(): readonly JsonRpcNotification[] {
    return this.#notifications;
  }

  /** Whether the connection is closed (child exited or we closed it). */
  get closed(): boolean {
    return this.#closed;
  }

  /** Send a request and await its response, or reject on timeout / disconnect. */
  async request(method: string, params?: unknown, timeoutMs = this.#timeoutMs): Promise<unknown> {
    if (this.#closed) throw new Error(`MCP 连接已关闭，无法发送 ${method}`);
    const { request, response } = this.#pairing.next(method, params);
    this.#child.stdin.write(encodeMessage(request));
    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`MCP 请求超时（${timeoutMs}ms）：${method}`)), timeoutMs);
    });
    try {
      return await Promise.race([response, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /** Send a notification (no response awaited). */
  notify(method: string, params?: unknown): void {
    if (this.#closed) return;
    this.#child.stdin.write(encodeMessage({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }));
  }

  /**
   * The MCP `initialize` handshake, then the `notifications/initialized` reply.
   *
   * MCP requires this exchange before any other request: the client sends
   * `initialize` with its protocol version and capabilities, the server answers
   * with its own, and the client confirms with the `initialized` notification.
   */
  async initialize(clientName: string): Promise<McpInitializeResult> {
    const result = (await this.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: clientName, version: "0.1.0" },
    })) as McpInitializeResult;
    this.notify("notifications/initialized");
    return result;
  }

  /**
   * Stop the child and fail any outstanding calls.
   *
   * Kills the whole process tree. On Windows the direct child may be a launcher
   * whose grandchildren survive `kill()`, so `taskkill /T /F` is used with a
   * direct-kill fallback — the discipline background-jobs.ts:216-236 established
   * after measuring a job that kept running after kill() reported success.
   */
  close(): void {
    this.#onClose("MCP 连接已被客户端关闭");
    const pid = this.#child.pid;
    if (pid !== undefined && process.platform === "win32") {
      try {
        const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
        killer.on("error", () => this.#directKill());
        return;
      } catch {
        // fall through
      }
    }
    this.#directKill();
  }

  #directKill(): void {
    try {
      this.#child.kill();
    } catch {
      // Already gone.
    }
  }
}

/**
 * Spawn an MCP server subprocess and wrap it in a client.
 *
 * The child is attached (not detached) and runs under the scrubbed
 * {@link ToolEnvironment}, so it inherits neither the operator's secrets nor a
 * shell. Call {@link McpClient.initialize} on the result before any other request.
 */
export function startMcpClient(
  spec: McpServerSpec,
  environment: ToolEnvironment,
  timeoutMs = MCP_REQUEST_TIMEOUT_MS,
): McpClient {
  const child = spawn(spec.command, [...(spec.args ?? [])], {
    cwd: environment.cwd,
    env: environment.env as NodeJS.ProcessEnv,
    shell: false,
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  }) as ChildProcessWithoutNullStreams;
  return new McpClient(child, timeoutMs);
}
