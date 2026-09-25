import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { withSessionLease } from "./session-lease.ts";
import { dirname, join } from "node:path";
import { lstatSync } from "node:fs";
import { assertSafeStateDirectory, canonicalPath, isWithin } from "./security-config.ts";
import type { ChatMessage, ChatUsage, ToolCall } from "./types.ts";

/**
 * Session event log, versioned and append-only.
 *
 * One JSON object per line, each carrying `v` (schema version). A reader
 * upgrades older lines through {@link migrateEvent} instead of failing, so a
 * session written today stays readable after the event shape changes.
 *
 * Event kinds:
 *  - `session`     : header, written once when the file is created
 *  - `message`     : one conversation turn (may carry tool calls or answer one)
 *  - `usage`       : token accounting for a model call
 *  - `tool/call`   : legacy audit record; **no longer written** (see below)
 *  - `tool/result` : legacy audit record; **no longer written** (see below)
 *
 * ## Single source of truth (ADR-0001)
 *
 * A tool invocation used to be written three times: an audit `tool/call`, an
 * audit `tool/result`, and the `message` that actually feeds the next prompt.
 * The audit pair was a copy, and keeping a copy meant the two could disagree —
 * which is why the reader carried conflict checks for exactly that case.
 *
 * New writes produce the message only: `assistant.toolCalls` records what was
 * requested, the `role:"tool"` message records what came back, and `isError`
 * rides on the event rather than inside {@link ChatMessage} (which is also the
 * wire format sent to providers).
 *
 * The audit kinds remain **readable but are never written**. That is not
 * sentiment: a legacy log interrupted between its `tool/result` and its message
 * holds a real recorded result, and skipping the pair would make recovery
 * fabricate "outcome unknown" over a result that was actually saved. Legacy
 * pairs are used only to answer "did this call already produce a result?",
 * never to reconstruct the conversation.
 *
 * ## Versioning rules
 *
 * A version bump is owed only when the shape of an *existing* kind changes.
 * Adding a new kind is not a structural change: new kinds are written with
 * `ignorable: true`, and a reader that does not recognise a kind skips it
 * instead of failing. This keeps an old reader working against a newer log,
 * which a bare version bump would not.
 */

export const CURRENT_EVENT_VERSION = 1;

export interface SessionHeaderEvent {
  v: number;
  kind: "session";
  id: string;
  createdAt: string;
}

export interface MessageEvent {
  v: number;
  kind: "message";
  at: string;
  message: ChatMessage;
  model?: string;
  /**
   * Identity of the `send` this turn belongs to. Opaque and unique per send —
   * deliberately not a timestamp or a counter, so nothing infers order from it.
   */
  runId?: string;
  /** Which model call inside that send produced this turn; `0` for the user turn. */
  step?: number;
  /**
   * Tool outcome marker, only meaningful for `role:"tool"`.
   *
   * It lives here and not on {@link ChatMessage} because that type is also the
   * provider wire format, and a host-only flag has no business reaching a model.
   */
  isError?: boolean;
}

export interface UsageEvent {
  v: number;
  kind: "usage";
  at: string;
  usage: ChatUsage;
}

export interface ToolCallEvent {
  v: number;
  kind: "tool/call";
  /** Marks the kind as skippable by a reader that predates it. */
  ignorable: true;
  at: string;
  callId: string;
  name: string;
  arguments: string;
}

export interface ToolResultEvent {
  v: number;
  kind: "tool/result";
  ignorable: true;
  at: string;
  callId: string;
  name: string;
  content: string;
  isError: boolean;
}

/**
 * Records that the first `covers` messages of this session's history are
 * represented, for prompt-building purposes, by `summary`.
 *
 * Nothing is deleted by writing this: `history()` still replays every message, so
 * inspection, recovery and pairing checks are unaffected. Only the prompt the
 * model sees is shortened, and it is shortened by an amount that is recorded here
 * rather than recomputed later from a heuristic.
 *
 * Marked `ignorable` so a reader that predates this kind skips it and builds the
 * full-length prompt — longer than intended, but not wrong.
 */
export interface SummaryEvent {
  v: number;
  kind: "summary";
  ignorable: true;
  at: string;
  covers: number;
  summary: string;
}

/** A denied or expired file approval. Ignorable so older readers skip it. */
export interface AuditEvent {
  v: number;
  kind: "audit";
  ignorable: true;
  at: string;
  tool: string;
  decision: "denied" | "expired";
  reason: string;
}

export type SessionEvent =
  | SessionHeaderEvent
  | MessageEvent
  | UsageEvent
  | ToolCallEvent
  | ToolResultEvent
  | SummaryEvent
  | AuditEvent;

/** Raised when a line cannot be read as a session event; carries its position. */
export class SessionCorruptionError extends Error {
  readonly sessionId: string;
  readonly line: number;
  readonly detail: string;
  readonly preview: string;

  constructor(sessionId: string, problem: SessionProblem) {
    super(`${sessionId}: line ${problem.line} is not a valid session event: ${problem.detail}`);
    this.name = "SessionCorruptionError";
    this.sessionId = sessionId;
    this.line = problem.line;
    this.detail = problem.detail;
    this.preview = problem.preview;
  }
}

export interface SessionProblem {
  /** 1-based line number in the file. */
  line: number;
  detail: string;
  /** The offending line, truncated, so a caller can show it without re-reading. */
  preview: string;
}

export function normalizeMessage(message: ChatMessage): ChatMessage {
  const normalized: ChatMessage = { role: message.role, content: message.content };
  if (message.toolCalls) {
    normalized.toolCalls = message.toolCalls.map((call) => ({
      id: call.id,
      name: call.name,
      arguments: call.arguments,
    }));
  }
  if (message.toolCallId !== undefined) normalized.toolCallId = message.toolCallId;
  return normalized;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  return value as Record<string, unknown>;
}

function requireString(record: Record<string, unknown>, key: string, where: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${where}.${key} must be a string`);
  return value;
}

function parseToolCalls(value: unknown, where: string): ToolCall[] {
  if (!Array.isArray(value)) throw new Error(`${where}.toolCalls must be an array`);
  return value.map((entry, index) => {
    const call = asRecord(entry);
    if (!call) throw new Error(`${where}.toolCalls[${index}] must be an object`);
    return {
      id: requireString(call, "id", `${where}.toolCalls[${index}]`),
      name: requireString(call, "name", `${where}.toolCalls[${index}]`),
      arguments: requireString(call, "arguments", `${where}.toolCalls[${index}]`),
    };
  });
}

/**
 * Validate one decoded line, upgrading it to {@link CURRENT_EVENT_VERSION}.
 *
 * Returns `null` for a kind this reader does not know that was explicitly
 * marked `ignorable` — the forward-compatibility escape hatch. An unmarked
 * unknown kind is still an error, because silently dropping an event we cannot
 * interpret would change what the model is reconstructed as having seen.
 *
 * The legacy audit kinds are now parsed best-effort. Since ADR-0001 stopped the
 * runtime writing them, they are no longer a shape this project guarantees, so a
 * truncated audit line in an old log must be skipped rather than made fatal —
 * otherwise a torn write would brick a session that has a perfectly good message
 * transcript right next to it. Well-formed legacy pairs still parse, because an
 * interrupted batch's recorded `tool/result` is the only evidence that a call
 * already produced a result, and recovery must not fabricate over it.
 */
export function migrateEvent(raw: unknown): SessionEvent | null {
  const record = asRecord(raw);
  if (!record) throw new Error("event is not a JSON object");

  const version = record.v;
  if (version !== undefined && typeof version !== "number") {
    throw new Error("v must be a number when present");
  }
  const v = version ?? 0;
  if (!Number.isSafeInteger(v) || v < 0) throw new Error("v must be a nonnegative integer");
  if (v > CURRENT_EVENT_VERSION) {
    throw new Error(`event version ${v} is newer than supported ${CURRENT_EVENT_VERSION}`);
  }

  const kind = record.kind;
  if (typeof kind !== "string") throw new Error("kind must be a string");
  const legacyFields = () =>
    typeof record.callId === "string" && record.callId.trim() !== "" &&
    typeof record.name === "string" && record.name.trim() !== "";

  switch (kind) {
    case "session": {
      const id = requireString(record, "id", "session");
      const createdAt = requireString(record, "createdAt", "session");
      return { v: CURRENT_EVENT_VERSION, kind, id, createdAt };
    }
    case "message": {
      const at = requireString(record, "at", "message");
      const message = asRecord(record.message);
      if (!message) throw new Error("message.message must be an object");
      const role = requireString(message, "role", "message.message");
      if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
        throw new Error(`message.message.role is not a known role: ${role}`);
      }
      const content = requireString(message, "content", "message.message");
      const outgoing: ChatMessage = { role, content };
      if (message.toolCalls !== undefined) {
        outgoing.toolCalls = parseToolCalls(message.toolCalls, "message.message");
      }
      if (message.toolCallId !== undefined) {
        outgoing.toolCallId = requireString(message, "toolCallId", "message.message");
      }
      if (outgoing.toolCalls !== undefined && role !== "assistant") throw new Error("toolCalls require assistant role");
      if (role === "tool" ? !outgoing.toolCallId?.trim() : outgoing.toolCallId !== undefined) throw new Error("toolCallId requires tool role and nonempty id");
      const ids = new Set<string>();
      for (const call of outgoing.toolCalls ?? []) {
        if (!call.id.trim() || !call.name.trim() || ids.has(call.id)) throw new Error("empty or duplicate tool id/name");
        ids.add(call.id);
      }
      const event: MessageEvent = { v: CURRENT_EVENT_VERSION, kind, at, message: outgoing };
      if (record.model !== undefined) event.model = requireString(record, "model", "message");
      if (record.runId !== undefined) {
        const runId = requireString(record, "runId", "message");
        if (!runId.trim()) throw new Error("message.runId must be non-empty when present");
        event.runId = runId;
      }
      if (record.step !== undefined) {
        const step = record.step;
        if (typeof step !== "number" || !Number.isSafeInteger(step) || step < 0) {
          throw new Error("message.step must be a nonnegative safe integer");
        }
        event.step = step;
      }
      if (record.isError !== undefined) {
        if (typeof record.isError !== "boolean") throw new Error("message.isError must be a boolean");
        if (role !== "tool") throw new Error("message.isError requires tool role");
        event.isError = record.isError;
      }
      return event;
    }
    case "usage": {
      const at = requireString(record, "at", "usage");
      const usage = asRecord(record.usage);
      if (!usage) throw new Error("usage.usage must be an object");
      const inputTokens = usage.inputTokens;
      const outputTokens = usage.outputTokens;
      if (typeof inputTokens !== "number" || typeof outputTokens !== "number" ||
          !Number.isSafeInteger(inputTokens) || inputTokens < 0 || !Number.isSafeInteger(outputTokens) || outputTokens < 0) {
        throw new Error("usage tokens must be nonnegative safe integers");
      }
      // Optional and additive: a log written before this field existed stays valid,
      // and a malformed value is reported rather than dropped into a total.
      const reasoningTokens = usage.reasoningTokens;
      if (reasoningTokens !== undefined &&
          (typeof reasoningTokens !== "number" || !Number.isSafeInteger(reasoningTokens) || reasoningTokens < 0)) {
        throw new Error("usage.reasoningTokens must be a nonnegative safe integer");
      }
      return { v: CURRENT_EVENT_VERSION, kind, at, usage: { inputTokens, outputTokens,
        ...(reasoningTokens === undefined ? {} : { reasoningTokens }) } };
    }
    case "tool/call": {
      if (!legacyFields()) return null;
      return {
        v: CURRENT_EVENT_VERSION,
        kind,
        ignorable: true,
        at: requireString(record, "at", "tool/call"),
        callId: requireString(record, "callId", "tool/call"),
        name: requireString(record, "name", "tool/call"),
        arguments: requireString(record, "arguments", "tool/call"),
      };
    }
    case "tool/result": {
      if (!legacyFields()) return null;
      const isError = record.isError;
      if (typeof isError !== "boolean") return null;
      return {
        v: CURRENT_EVENT_VERSION,
        kind,
        ignorable: true,
        at: requireString(record, "at", "tool/result"),
        callId: requireString(record, "callId", "tool/result"),
        name: requireString(record, "name", "tool/result"),
        content: requireString(record, "content", "tool/result"),
        isError,
      };
    }
    case "summary": {
      const covers = record.covers;
      if (typeof covers !== "number" || !Number.isSafeInteger(covers) || covers < 0) {
        throw new Error("summary.covers must be a non-negative integer");
      }
      return {
        v: CURRENT_EVENT_VERSION,
        kind,
        ignorable: true,
        at: requireString(record, "at", "summary"),
        covers,
        summary: requireString(record, "summary", "summary"),
      };
    }
    case "audit": {
      const decision = record.decision;
      if (decision !== "denied" && decision !== "expired") throw new Error("audit.decision must be denied or expired");
      return {
        v: CURRENT_EVENT_VERSION,
        kind,
        ignorable: true,
        at: requireString(record, "at", "audit"),
        tool: requireString(record, "tool", "audit"),
        decision,
        reason: requireString(record, "reason", "audit"),
      };
    }
    default:
      if (record.ignorable === true) return null;
      throw new Error(`unknown event kind: ${kind}`);
  }
}

export interface AppendMessageOptions {
  model?: string;
  runId?: string;
  step?: number;
  isError?: boolean;
}

export interface SessionStoreOptions {
  /** Directory holding `<id>.jsonl` session files. */
  root: string;
  /**
   * `flush` (default) makes every append flush its bytes before resolving.
   * `relaxed` writes and closes without flushing — faster, and no longer
   * durable: a resolved append may still be lost to a power cut. Choose it only
   * when the caller keeps its own copy or can tolerate losing recent turns.
   */
  durability?: "flush" | "relaxed";
}

export interface InspectionResult {
  events: SessionEvent[];
  eventLines: number[];
  /** Lines that could not be read; empty for a healthy session. */
  problems: SessionProblem[];
}

const PREVIEW_LIMIT = 120;

/**
 * The minimum this store needs from an open append handle.
 *
 * Narrowed to an interface on purpose: it makes the durability step
 * (`sync`) an observable call a test can count and make fail, which is the only
 * way to verify "the append is flushed" without a real power cut.
 */
export interface AppendHandle {
  write(data: string): Promise<unknown>;
  sync(): Promise<void>;
  close(): Promise<void>;
}

export class SessionStore {
  readonly root: string;

  /**
   * Durability of `append`. See {@link durableAppend}: "flush" means each event
   * is flushed before the append resolves. Public because it is part of the
   * store's observable contract, not an implementation detail.
   */
  readonly durability: "flush" | "relaxed";

  constructor(options: SessionStoreOptions) {
    this.root = assertSafeStateDirectory(options.root);
    this.durability = options.durability ?? "flush";
  }

  /**
   * Open the log for one durable append, or return `undefined` to take the
   * non-syncing path.
   *
   * Returning `undefined` is the "relaxed" durability mode: the bytes are
   * written and closed, but the call resolving no longer means they were handed
   * to the device. It is a documented opt-out, not a silent fallback.
   */
  protected async openAppend(path: string): Promise<AppendHandle | undefined> {
    if (this.durability === "relaxed") return undefined;
    return open(path, "a");
  }

  /**
   * Durability of `append`. See the class docs: "flush" means each event is
   * flushed before the append resolves.
   */
  pathFor(sessionId: string): string {
    if (!/^[A-Za-z0-9._-]+$/.test(sessionId)) throw new Error(`invalid session id: ${sessionId}`);
    const root = assertSafeStateDirectory(this.root);
    if (root !== this.root) throw new Error("session store root changed");
    const target = join(root, `${sessionId}.jsonl`);
    try {
      const info = lstatSync(target);
      if (info.isSymbolicLink() || !info.isFile() || info.nlink > 1) throw new Error("linked or non-regular session file refused");
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    const actual = canonicalPath(target);
    if (!isWithin(root, actual)) throw new Error("session path escapes store");
    return actual;
  }

  async withWriter<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    return withSessionLease(this.pathFor(sessionId), action);
  }

  private async mutation<T>(sessionId: string, action: () => Promise<T>): Promise<T> {
    return withSessionLease(this.pathFor(sessionId), action, true);
  }

  /**
   * Append one line and flush it.
   *
   * `appendFile` + close is not durable: it returns once the process has written
   * the bytes, and a power cut can still lose them. `fsync` is what turns "the
   * write call returned" into "the device was asked to persist".
   *
   * What this buys, exactly:
   *  - the event's bytes are flushed before the append resolves;
   *  - a `sync` failure rejects the append, so a flush that did not happen is
   *    never reported as success;
   *  - each event is one line, so the flush boundary is per event.
   *
   * What it does not buy (do not read more into it):
   *  - **not tested against real power loss here** — no test in this project cuts
   *    power, so the claim is "we flush and we surface failures", not "data
   *    survives a power cut";
   *  - no directory-entry durability: on Windows a directory cannot be opened
   *    for `fsync`, so a brand-new session file's *name* is not separately
   *    flushed. A file created just before power loss may be absent even though
   *    its contents were flushed;
   *  - no defence against hardware or a filesystem that reports a completed
   *    flush without persisting it;
   *  - nothing across appends: a crash between two flushed events is a torn
   *    *transcript*, which is what inspection and recovery exist for, not fsync.
   */
  private async durableAppend(path: string, line: string): Promise<void> {
    const handle = await this.openAppend(path);
    if (!handle) {
      await writeFile(path, line, { encoding: "utf8", flag: "a" });
      return;
    }
    try {
      await handle.write(line);
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async create(sessionId: string): Promise<SessionHeaderEvent> {
    return this.mutation(sessionId, async () => {
    const existing = await this.read(sessionId);
    if (existing.length) return existing[0] as SessionHeaderEvent;
    const header: SessionHeaderEvent = {
      v: CURRENT_EVENT_VERSION,
      kind: "session",
      id: sessionId,
      createdAt: new Date().toISOString(),
    };
    await mkdir(dirname(this.pathFor(sessionId)), { recursive: true });
    // `wx` keeps creation exclusive: two processes racing to create the same
    // session cannot both win, so the header is written exactly once.
    await writeFile(this.pathFor(sessionId), `${JSON.stringify(header)}\n`, {encoding:"utf8",flag:"wx"});
    return header;
    });
  }

  async append(sessionId: string, event: SessionEvent): Promise<void> {
    // Validate before JSON.stringify can turn Infinity/NaN into null.
    const validated = migrateEvent(event);
    if (!validated || validated.kind === "session") throw new Error("append requires a known non-header event");
    await this.mutation(sessionId, async () => {
      // create strictly reads the existing log (or writes a new header) under this lease.
      await this.create(sessionId);
      await this.durableAppend(this.pathFor(sessionId), `${JSON.stringify(validated)}\n`);
    });
  }

  async appendMessage(
    sessionId: string,
    message: ChatMessage,
    options: AppendMessageOptions = {},
  ): Promise<MessageEvent> {
    const event: MessageEvent = {
      v: CURRENT_EVENT_VERSION,
      kind: "message",
      at: new Date().toISOString(),
      message: normalizeMessage(message),
      ...(options.model ? { model: options.model } : {}),
      ...(options.runId ? { runId: options.runId } : {}),
      ...(options.step === undefined ? {} : { step: options.step }),
      ...(options.isError === undefined ? {} : { isError: options.isError }),
    };
    await this.append(sessionId, event);
    return event;
  }

  async appendUsage(sessionId: string, usage: ChatUsage): Promise<UsageEvent> {
    const event: UsageEvent = { v: CURRENT_EVENT_VERSION, kind: "usage", at: new Date().toISOString(), usage };
    await this.append(sessionId, event);
    return event;
  }

  /**
   * Record that the first `covers` messages are represented by `summary`.
   *
   * `covers` is checked against this session's own message count rather than
   * trusted, because it is the boundary that decides which turns leave the
   * prompt: a value that is too large would hide turns the summary never saw.
   * Refusing the mismatch keeps the boundary an observed fact.
   *
   * Compaction is also refused while a tool batch is unfinished. Summarizing a
   * call whose result has not arrived would leave the model with an answer-shaped
   * summary of a question that was never resolved.
   */
  async appendSummary(sessionId: string, summary: { covers: number; summary: string }): Promise<SummaryEvent> {
    if (summary.summary.trim() === "") throw new Error("summary must not be empty");
    if (!Number.isSafeInteger(summary.covers) || summary.covers < 0) throw new Error("summary.covers must be a non-negative integer");
    const pending = await this.pendingTools(sessionId);
    if (pending.length > 0) {
      throw new Error(`refusing to summarize while ${pending.length} tool result(s) are missing; complete or recover the batch first`);
    }
    const history = await this.history(sessionId);
    if (summary.covers !== history.length) {
      throw new Error(`summary.covers must equal this session's message count (${history.length}), got ${summary.covers}`);
    }
    const event: SummaryEvent = {
      v: CURRENT_EVENT_VERSION,
      kind: "summary",
      ignorable: true,
      at: new Date().toISOString(),
      covers: summary.covers,
      summary: summary.summary,
    };
    await this.append(sessionId, event);
    return event;
  }

  /** Record one denied or expired approval without changing the conversation. */
  async appendAudit(sessionId: string, audit: Pick<AuditEvent, "tool" | "decision" | "reason">): Promise<AuditEvent> {
    const event: AuditEvent = {
      v: CURRENT_EVENT_VERSION, kind: "audit", ignorable: true, at: new Date().toISOString(), ...audit,
    };
    await this.append(sessionId, event);
    return event;
  }

  /**
   * The most recent compaction, or undefined when the session is uncompacted.
   *
   * The latest event wins because `covers` only ever grows: a later summary was
   * built from everything the earlier one covered.
   */
  async compaction(sessionId: string): Promise<SummaryEvent | undefined> {
    const report = await this.inspect(sessionId);
    let latest: SummaryEvent | undefined;
    for (const event of report.events) {
      if (event.kind === "summary") latest = event;
    }
    return latest;
  }

  /**
   * Read every line, reporting malformed ones instead of aborting on the first.
   *
   * This is the salvage path: a single truncated write should still leave the
   * rest of the conversation inspectable, with the damage located precisely.
   */
  async inspect(sessionId: string): Promise<InspectionResult> {
    let text: string;
    try {
      text = await readFile(this.pathFor(sessionId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], eventLines: [], problems: [] };
      throw error;
    }
    const events: SessionEvent[] = [];
    const eventLines: number[] = [];
    const problems: SessionProblem[] = [];
    if (!text.length) problems.push({line:1,detail:"existing session file is empty; manual inspection required",preview:""});
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim() ?? "";
      if (line.length === 0) continue;
      const lineNumber = index + 1;
      try {
        const event = migrateEvent(JSON.parse(line));
        if (event) { events.push(event); eventLines.push(lineNumber); }
      } catch (error) {
        problems.push({
          line: lineNumber,
          detail: error instanceof SyntaxError ? "invalid JSON (raw content hidden)" : (error as Error).message,
          preview: line.length > PREVIEW_LIMIT ? `${line.slice(0, PREVIEW_LIMIT)}…` : line,
        });
      }
    }
    if (text.length && !text.endsWith("\n")) problems.push({line:lines.length,detail:"unterminated final line; possible interrupted write",preview:""});
    const headers = events.filter(e=>e.kind==="session");
    if (text.length && (headers.length!==1 || events[0]?.kind!=="session" || headers[0]?.id!==sessionId)) {
      problems.push({line:1,detail:"session header missing, duplicated or id mismatch",preview:""});
    }
    return { events, eventLines, problems };
  }

  /**
   * Strict read. Any unreadable line is fatal, because a silently skipped event
   * would change what the model is reconstructed as having seen — and a
   * corrupted history yields an agent that is subtly not the one that ran.
   */
  async read(sessionId: string): Promise<SessionEvent[]> {
    const { events, problems } = await this.inspect(sessionId);
    const first = problems[0];
    if (first) throw new SessionCorruptionError(sessionId, first);
    return events;
  }

  /** Check transcript pairing without interpreting an incomplete batch as executable work. */
  async pendingTools(sessionId: string): Promise<{call:ToolCall; result?:ToolResultEvent}[]> {
    const pending = new Map<string,{call:ToolCall;result?:ToolResultEvent;seenCall?:boolean}>();
    const report = await this.inspect(sessionId);
    if (report.problems[0]) throw new SessionCorruptionError(sessionId, report.problems[0]);
    for (const [index, event] of report.events.entries()) {
      try {
      if (event.kind === "message") {
        const message = event.message;
        if (message.role === "tool") {
          const item = pending.get(message.toolCallId!);
          if (!item) throw new Error("orphan or duplicate tool message; manual inspection required");
          if(item.result && item.result.content!==message.content) throw new Error("tool result/message conflict; manual inspection required");
          pending.delete(message.toolCallId!);
        } else {
          if (pending.size) throw new Error("message interrupts unfinished tool batch; manual inspection required");
          for(const call of message.toolCalls??[])pending.set(call.id,{call});
        }
      } else if(event.kind==="tool/call" || event.kind==="tool/result") {
        const item=pending.get(event.callId);
        if(!item || item.call.name!==event.name)throw new Error("orphan or mismatched tool audit event; manual inspection required");
        if(event.kind==="tool/call") {
          // One call has one audit record. A second `tool/call` for the same id is
          // not a retry this store can reason about, so it is refused instead of
          // being silently absorbed — the recorded arguments would otherwise be
          // whichever copy happened to be checked first.
          if(item.seenCall) throw new Error("duplicate tool call audit event; manual inspection required");
          if(item.call.arguments!==event.arguments)throw new Error("tool arguments mismatch");
          item.seenCall=true;
        }
        if(event.kind==="tool/result") {
          if(item.result)throw new Error("duplicate tool result; manual inspection required");
          item.result=event;
        }
      }
      } catch(error) {
        const callId=event.kind==="tool/call"||event.kind==="tool/result" ? event.callId : event.kind==="message" ? event.message.toolCallId : undefined;
        throw new SessionCorruptionError(sessionId,{line:report.eventLines[index]!,detail:`${(error as Error).message}${callId?` (callId=${JSON.stringify(callId)})`:""}`,preview:""});
      }
    }
    return [...pending.values()];
  }

  async assertReady(sessionId: string): Promise<void> {
    const pending = await this.pendingTools(sessionId);
    if(pending.length)throw new Error(`会话有 ${pending.length} 个未完成工具结果；先 /inspect，再显式 /recover。不会自动重跑工具。`);
  }

  /** Explicit repair: only append missing tool messages; never execute or erase anything. */
  async recover(sessionId: string): Promise<number> {
    return this.withWriter(sessionId,async()=>{
      const pending=await this.pendingTools(sessionId);
      for(const item of pending){
        const result=item.result??{content:"interrupted: execution outcome unknown; tool was NOT replayed during recovery",isError:true};
        await this.appendMessage(sessionId,{role:"tool",toolCallId:item.call.id,content:result.content},{isError:result.isError===true});
      }
      return pending.length;
    });
  }

  /** Replay just the conversation, in order — the runtime's load path. */
  async history(sessionId: string): Promise<ChatMessage[]> {
    const events = await this.read(sessionId);
    return events.filter((event): event is MessageEvent => event.kind === "message").map((event) => event.message);
  }

  async totals(sessionId: string): Promise<ChatUsage> {
    const events = await this.read(sessionId);
    const total = events
      .filter((event): event is UsageEvent => event.kind === "usage")
      .reduce<ChatUsage>(
        (sum, event) => {
          const reasoning = event.usage.reasoningTokens;
          return {
            inputTokens: sum.inputTokens + event.usage.inputTokens,
            outputTokens: sum.outputTokens + event.usage.outputTokens,
            // Kept absent while nothing reported it, so a session that never saw a
            // reasoning trace reports no reasoning rather than a confident zero.
            ...(reasoning === undefined ? {} : { reasoningTokens: (sum.reasoningTokens ?? 0) + reasoning }),
          };
        },
        { inputTokens: 0, outputTokens: 0 },
      );
    return total;
  }

  async exists(sessionId: string): Promise<boolean> {
    return (await this.read(sessionId)).length > 0;
  }
}
