import { mkdir, open, readFile, writeFile } from "node:fs/promises";
import { withSessionLease } from "./session-lease.ts";
import { dirname, join } from "node:path";
import { lstatSync } from "node:fs";
import { assertSafeStateDirectory, canonicalPath, isWithin } from "./security-config.ts";
import type { ChatMessage, ChatUsage, ToolCall } from "./types.ts";
// Type-only: the claim vocabulary is shared with genes (D60 established it names
// observable facts, not gene-specific ones), and a type import is erased at
// runtime, so the log gains no runtime dependency on the gene module.
import type { GeneValidation } from "./gene.ts";
import { assertNotWeakened, formatTaskStateForPrompt, MAX_TASK_STATE_BYTES, type TaskStateInput, type TaskStateStep } from "./task-state.ts";

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

/**
 * The task's persistent state: prose progress plus one acceptance criterion per
 * step. Marked `ignorable` so a reader that predates this kind skips it — it then
 * builds a prompt with no state block, which is *longer than intended, but not
 * wrong*, the same degradation `SummaryEvent` accepts.
 *
 * There is deliberately no `done` field. Completion is computed by
 * {@link assessTaskState} from the claims against journal evidence, never stored,
 * because a step the writer marked finished is the writer reporting its own
 * success (D14/D15/D19). `atMessage` is the message count observed when this was
 * written — the same device as `covers`, so the boundary stays an observed fact.
 */
export interface TaskStateEvent {
  v: number;
  kind: "task-state";
  ignorable: true;
  at: string;
  atMessage: number;
  state: string;
  steps: readonly TaskStateStep[];
}

/**
 * A recorded permission decision: something was denied, an approval expired, or a
 * boundary was widened by configuration. Ignorable so older readers skip it.
 *
 * `"allowed"` exists because an audit log that records a grant under the word
 * "denied" is worse than no log: the whole point of the file is that someone can
 * read it later and answer "who stopped asking, and when".
 */
export interface AuditEvent {
  v: number;
  kind: "audit";
  ignorable: true;
  at: string;
  tool: string;
  decision: "denied" | "expired" | "allowed";
  reason: string;
  /** The rule that refused, when a rule decided it. Null when nothing matched. */
  rule?: string | null;
}

/**
 * An event kind the core does not know, registered from outside.
 *
 * `ignorable: true` is forced by the type, not by convention, and the reason is
 * this file's own contract: a reader that does not recognise a kind skips it,
 * while an *unmarked* unknown kind is an error — because silently dropping an
 * event we cannot interpret would change what the model is reconstructed as
 * having seen. A kind the core cannot interpret must therefore be skippable by
 * construction; otherwise it is not an external kind but a corrupt line.
 *
 * `payload` is opaque. The core stores it, replays it, and never reads it, so the
 * whole event still lives in the log: ADR-0001's fact source and DSH's
 * "model-visible means logged" both hold without the core understanding a word.
 */
export interface ExternalSessionEvent {
  v: number;
  kind: string;
  ignorable: true;
  at: string;
  payload: unknown;
}

/** Parses one decoded line of a registered kind. Receives the raw record. */
export type EventKindHandler = (
  record: Record<string, unknown>,
) => ExternalSessionEvent | null;

/** The kinds the core itself parses. Registration refuses every one of them. */
const BUILTIN_EVENT_KINDS: ReadonlySet<string> = new Set([
  "session",
  "message",
  "usage",
  "tool/call",
  "tool/result",
  "summary",
  "task-state",
  "audit",
]);

const externalEventKinds = new Map<string, { readonly token: symbol; readonly handler: EventKindHandler }>();

/**
 * Register a session event kind from outside the core.
 *
 * Returns a disposer, because a registration is an effect and effects unwind
 * (Cordis idea 5). Ownership is a unique token, **not** the handler's identity:
 * the same plugin reloaded registers the same function object, and a disposer that
 * matched on identity would unregister the live registration behind it.
 *
 * Refusing builtin kinds is a safety property, not a convenience: registering
 * `"message"` would let a caller reinterpret the conversation's fact source
 * itself. That is D04's "模型/插件不得自行扩大授权" applied to the event log.
 */
export function registerEventKind(kind: string, handler: EventKindHandler): () => void {
  if (typeof kind !== "string" || kind.trim() === "") {
    throw new Error("kind must be a non-empty string");
  }
  if (BUILTIN_EVENT_KINDS.has(kind)) {
    throw new Error(`cannot register builtin event kind: ${kind}`);
  }
  const existing = externalEventKinds.get(kind);
  if (existing !== undefined) {
    throw new Error(`event kind already registered: ${kind}`);
  }
  const token = Symbol(kind);
  externalEventKinds.set(kind, { token, handler });
  return () => {
    const current = externalEventKinds.get(kind);
    if (current !== undefined && current.token === token) externalEventKinds.delete(kind);
  };
}

/** The externally registered kinds. What can be listed can be audited. */
export function registeredEventKinds(): readonly string[] {
  return [...externalEventKinds.keys()];
}

/**
 * The kinds the core itself parses.
 *
 * ⚠️ `ExternalSessionEvent` is deliberately **not** a member. Adding it was tried
 * and measured: because its `kind` is `string`, it overlaps every literal, so
 * TypeScript can no longer exclude it at the eight sites that narrow on
 * `event.kind === "…"`. Six are trivial, but one (`inspect`'s tool-batch audit)
 * narrows disjunctively over `tool/call | tool/result` and then reads `callId`,
 * `name` and `arguments` — rewriting that to a type predicate would put a safety
 * check at risk to buy a type-level convenience.
 *
 * Separating the two collections instead is both smaller and more honest: the
 * core's own projections genuinely have nothing to say about kinds they do not
 * understand, and `SessionInspection.external` still surfaces them, so nothing is
 * silently dropped.
 */
export type SessionEvent =
  | SessionHeaderEvent
  | MessageEvent
  | UsageEvent
  | ToolCallEvent
  | ToolResultEvent
  | SummaryEvent
  | TaskStateEvent
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
export function migrateEvent(raw: unknown): SessionEvent | ExternalSessionEvent | null {
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

  // Externally registered kinds are consulted first; the builtin switch below is
  // left untouched, so no existing kind's validation changes.
  const registered = externalEventKinds.get(kind);
  if (registered !== undefined) {
    const parsed = registered.handler(record);
    if (!parsed) {
      throw new Error(`event kind handler returned nothing usable: ${kind}`);
    }
    // Normalise. The handler cannot claim a version this reader does not support,
    // cannot rename the kind, and cannot make itself non-ignorable — the version
    // gate above already ran, and `ignorable` is what lets an older reader skip a
    // kind it has no way to interpret.
    return {
      v: CURRENT_EVENT_VERSION,
      kind,
      ignorable: true,
      at: typeof parsed.at === "string" ? parsed.at : "",
      payload: parsed.payload,
    };
  }

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
    case "task-state": {
      const atMessage = record.atMessage;
      if (typeof atMessage !== "number" || !Number.isSafeInteger(atMessage) || atMessage < 0) {
        throw new Error("task-state.atMessage must be a non-negative integer");
      }
      const rawSteps = record.steps;
      if (!Array.isArray(rawSteps)) throw new Error("task-state.steps must be an array");
      // Rebuilt field by field, so `claim` must be read here or it would vanish on
      // the way back in — the trap the `audit` case below warns about. Only the
      // shape is checked: a claim with an unknown kind falls through to
      // `checkClaim`'s default and is honestly reported `unverifiable`, which is
      // safer than guessing what it meant.
      const steps: TaskStateStep[] = rawSteps.map((entry, index) => {
        if (entry === null || typeof entry !== "object") throw new Error(`task-state.steps[${index}] must be an object`);
        const step = entry as { text?: unknown; claim?: unknown };
        if (typeof step.text !== "string") throw new Error(`task-state.steps[${index}].text must be a string`);
        if (step.claim === undefined) return { text: step.text };
        if (step.claim === null || typeof step.claim !== "object") {
          throw new Error(`task-state.steps[${index}].claim must be an object or absent`);
        }
        const kind = (step.claim as { kind?: unknown }).kind;
        if (typeof kind !== "string" || kind === "") {
          throw new Error(`task-state.steps[${index}].claim.kind must be a non-empty string`);
        }
        return { text: step.text, claim: step.claim as GeneValidation };
      });
      return {
        v: CURRENT_EVENT_VERSION,
        kind,
        ignorable: true,
        at: requireString(record, "at", "task-state"),
        atMessage,
        state: requireString(record, "state", "task-state"),
        steps,
      };
    }
    case "audit": {
      const decision = record.decision;
      // Widened for "allowed" (D26) when configuration gained the ability to stop
      // a prompt, which is a boundary removal and has to be as reviewable as a
      // refusal. This is the reader, so it also has to keep accepting every value
      // an older build already wrote.
      if (decision !== "denied" && decision !== "expired" && decision !== "allowed") {
        throw new Error("audit.decision must be denied, expired or allowed");
      }
      // Rebuilt field by field, so `rule` must be read here or it would vanish on
      // the way back in. Absent stays absent: an older line has no rule to name,
      // which is different from a line whose rule was "none matched".
      const rule = record.rule;
      if (rule !== undefined && rule !== null && typeof rule !== "string") {
        throw new Error("audit.rule must be a string or null");
      }
      return {
        v: CURRENT_EVENT_VERSION,
        kind,
        ignorable: true,
        at: requireString(record, "at", "audit"),
        tool: requireString(record, "tool", "audit"),
        decision,
        reason: requireString(record, "reason", "audit"),
        ...(rule === undefined ? {} : { rule: rule as string | null }),
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
  /**
   * Events of kinds the core does not understand, with the line each came from.
   * Kept out of `events` because `events` and `eventLines` are parallel arrays and
   * the header check asserts `events[0]` is the session header.
   */
  external: { readonly line: number; readonly event: ExternalSessionEvent }[];
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

  /**
   * Record the task's current state, replacing the previous one for prompt
   * purposes while leaving every earlier version in the log.
   *
   * Two refusals are inherited from {@link appendSummary} because they answer the
   * same question. A pending tool batch means part of this round is still
   * unresolved, and writing "this step is finished" over an unanswered call is
   * recording an open question as a closed one. And `atMessage` is read off the
   * history rather than supplied by the caller, so the boundary stays an observed
   * fact.
   *
   * The third refusal is this event's own: {@link assertNotWeakened}. Steps may be
   * appended to and prose may be rewritten freely, but an acceptance criterion
   * once recorded cannot be lowered, swapped or dropped — that is the one edit
   * that would let a writer pass by moving the bar instead of reaching it.
   */
  async appendTaskState(sessionId: string, input: TaskStateInput): Promise<TaskStateEvent> {
    if (input.state.trim() === "") throw new Error("task-state.state must not be empty");
    // Sized as rendered, because that is what will ride in every later prompt.
    // Refused here rather than at injection time: an injection-time refusal would
    // make every subsequent buildPrompt throw, so one oversized write would deny
    // service to the rest of the session. Reported with the actual size, never
    // truncated — a silently shortened criterion is a criterion the writer did not
    // agree to.
    const renderedBytes = Buffer.byteLength(formatTaskStateForPrompt(input.state, input.steps) ?? "", "utf8");
    if (renderedBytes > MAX_TASK_STATE_BYTES) {
      throw new Error(`任务状态渲染后为 ${renderedBytes} 字节，超过上限 ${MAX_TASK_STATE_BYTES} 字节；请缩短进度或步骤，不会截断`);
    }
    // No pending-tool refusal here, and the reason is worth stating because the
    // obvious move is to copy the one `appendSummary` makes. That refusal protects
    // a summary, which *replaces* what the model sees: summarizing an unanswered
    // call freezes "an answer-shaped summary of a question that was never resolved"
    // into the prompt. A task-state record replaces nothing — every message still
    // replays, and the pending result still arrives and is still shown — so the
    // harm that guard exists to prevent does not exist here.
    //
    // Copying it would have been fatal rather than merely wrong: this is written by
    // a tool, so the call doing the writing is itself pending at that moment, and
    // the guard would refuse every write the tool ever attempted. Found by an
    // end-to-end test; no unit test of the store alone could have caught it.
    const previous = await this.taskState(sessionId);
    assertNotWeakened(previous?.steps, input.steps);
    const event: TaskStateEvent = {
      v: CURRENT_EVENT_VERSION,
      kind: "task-state",
      ignorable: true,
      at: new Date().toISOString(),
      atMessage: (await this.history(sessionId)).length,
      state: input.state,
      steps: [...input.steps],
    };
    await this.append(sessionId, event);
    return event;
  }

  /**
   * The most recent task state, or undefined when none was recorded.
   *
   * Latest wins, as in {@link compaction}. Unlike a summary there is no `covers`
   * ordering to justify it: monotonicity does, because a later state was refused
   * unless it required at least as much as the earlier one.
   */
  async taskState(sessionId: string): Promise<TaskStateEvent | undefined> {
    const report = await this.inspect(sessionId);
    let latest: TaskStateEvent | undefined;
    for (const event of report.events) {
      if (event.kind === "task-state") latest = event;
    }
    return latest;
  }

  /**
   * Both "latest wins" marks in one pass.
   *
   * `buildPrompt` needs the compaction boundary and the task state on every model
   * call, and each of {@link compaction} and {@link taskState} reads the whole log
   * to answer. Calling both would read it twice per call, which on a long session
   * is the dominant cost of building a prompt. One pass, same answers.
   */
  async latestMarks(sessionId: string): Promise<{ compaction?: SummaryEvent; taskState?: TaskStateEvent }> {
    const report = await this.inspect(sessionId);
    let compaction: SummaryEvent | undefined;
    let taskState: TaskStateEvent | undefined;
    for (const event of report.events) {
      if (event.kind === "summary") compaction = event;
      else if (event.kind === "task-state") taskState = event;
    }
    return {
      ...(compaction === undefined ? {} : { compaction }),
      ...(taskState === undefined ? {} : { taskState }),
    };
  }

  /** Record one denied or expired approval without changing the conversation. */
  async appendAudit(sessionId: string, audit: Pick<AuditEvent, "tool" | "decision" | "reason"> & { rule?: string | null }): Promise<AuditEvent> {
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
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { events: [], eventLines: [], external: [], problems: [] };
      throw error;
    }
    const events: SessionEvent[] = [];
    const eventLines: number[] = [];
    /**
     * Kinds the core does not understand, kept separate on purpose.
     *
     * `events` and `eventLines` are parallel arrays, and the header check below
     * asserts that `events[0]` is the session header — so an external event must
     * enter neither. Its line number is kept here because it is free at this point
     * in the loop and impossible to recover later. Nothing is dropped: the whole
     * event is still in the log and still surfaced, just not through a collection
     * whose consumers cannot interpret it.
     */
    const external: { readonly line: number; readonly event: ExternalSessionEvent }[] = [];
    const problems: SessionProblem[] = [];
    if (!text.length) problems.push({line:1,detail:"existing session file is empty; manual inspection required",preview:""});
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]?.trim() ?? "";
      if (line.length === 0) continue;
      const lineNumber = index + 1;
      try {
        const event = migrateEvent(JSON.parse(line));
        if (event) {
          // Routed by kind, not by type narrowing — which is exactly why
          // `SessionEvent` can stay a closed union.
          if (BUILTIN_EVENT_KINDS.has(event.kind)) {
            events.push(event as SessionEvent);
            eventLines.push(lineNumber);
          } else {
            external.push({ line: lineNumber, event: event as ExternalSessionEvent });
          }
        }
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
    return { events, eventLines, external, problems };
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
