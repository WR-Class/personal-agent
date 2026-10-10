import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { ChatMessage, ChatUsage, ModelAdapter, ToolCall } from "./types.ts";
import type { SessionStore } from "./session-store.ts";
import type { ToolContext, ToolRegistry } from "./tools.ts";
import { RULE_TIERS, type Rule } from "./rule-table.ts";
import { buildToolEnvironment, UnsafeAgentHomeError } from "./tool-environment.ts";
import type { ToolEnvironment } from "./tool-environment.ts";
import { resolveRuntimePaths, assertSafeStateDirectory } from "./security-config.ts";
import { readTrustedRoots } from "./trusted-roots.ts";
import { formatConstraintsForPrompt, loadConstraints } from "./constraints.ts";
import { assessTaskState, formatTaskStateForPrompt, type TaskStateAssessment } from "./task-state.ts";

import { validateResponse } from "./response-validation.ts";
import { buildTaskSpec, assessTaskSpec, TASK_MODE } from "./taskspec.ts";
import { assembleTaskPrompt, type TaskPromptSkill } from "./taskspec-prompt.ts";
import { listSkills } from "./skill-catalogue.ts";
import type { TaskIntent, TaskSpec } from "./taskspec.ts";
import { budgetFor, chargeWrite, checkWrite, raiseFor, readWriteAttempt, WriteBudgetError, type LedgerState, type WriteBudget } from "./write-budget.ts";
import { omittedResultPlaceholder, projectOversizedToolResults } from "./obs-recall.ts";
import { checkValidation, claimsOf, validationEvidence, type ValidationReport } from "./validation.ts";
import type { GeneStore } from "./gene-store.ts";
import type { CycleStore } from "./cycle-store.ts";
import { applyEvent, evaluateRun, startCycle } from "./cycle.ts";
import type { CycleEvaluation, CycleEvent, CycleState, FailureClass } from "./cycle.ts";

export interface RuntimeActivity { type: "model" | "tool-start" | "tool-end"; name?: string; callId?: string; isError?: boolean; arguments?: string; content?: string; }
// UI evidence is bounded; the session store retains the full authoritative result.
function activityText(text: string): string { return text.length > 24_000 ? text.slice(0,24_000)+'\n【即时预览已截断，完整记录见本轮结束后的执行证据】' : text; }
export interface AgentRuntimeOptions {
  onActivity?: (event: RuntimeActivity) => void;
  /** One-shot operator question. Used only by edit_file. */
  approve?(prompt: string): Promise<boolean>;
  /**
   * Hard-refuse an incomplete TaskSpec instead of recording it. Off by
   * default: an incomplete spec is reported in SendResult, not fatal.
   */
  enforceTaskSpec?: boolean;
  /**
   * The rule table this session runs under (D31). Absent means the built-in
   * rules, which is why adding a tier never silently changes an existing
   * caller. Forwarded to every tool call so the decision and its attribution
   * come from one place.
   */
  rules?: readonly Rule[];
  /**
   * The gene library (D14). When present, every send selects a gene by the
   * TaskSpec's intent and signals, injects its strategy as system context
   * (test-time evolution), and journals an outcome row — `address: null`
   * when no gene matched, which is the baseline future gain pricing needs.
   */
  geneStore?: GeneStore;
  /**
   * The cycle journal (D15). When present, every send journals the PDRI events
   * it went through, so a round can be replayed instead of trusted. The machine
   * runs either way; this is what makes it auditable after the process exits.
   */
  cycleStore?: CycleStore;
  adapter: ModelAdapter;
  store: SessionStore;
  sessionId: string;
  /** Boundary every filesystem tool resolves against. Defaults to the cwd. */
  workspaceRoot?: string;
  /**
   * The agent's **own** home: where its state lives, and the value a tool's
   * `HOME` / `USERPROFILE` is rewritten to.
   *
   * Defaults to {@link DEFAULT_AGENT_HOME} under the cwd. It is never the
   * operator's home, and the constructor fails when it overlaps one — see
   * {@link buildToolEnvironment} for why that is a refusal and not a warning.
   */
  home?: string;
  /** Additional trusted host/backup roots, never supplied by the model. */
  protectedRoots?: readonly string[];
  tools?: ToolRegistry;
  /**
   * Maximum model calls in one `send`. Defaults to {@link DEFAULT_MAX_STEPS}.
   *
   * Optional operator cap on working calls; default unlimited. An explicit cap
   * permits one additional tools-disabled summary, never another tool action.
   * Per-step tool and context boundaries remain independent.
   */
  maxSteps?: number;
  /**
   * Maximum tool invocations in one model step. Defaults to
   * {@link DEFAULT_MAX_TOOL_CALLS_PER_STEP}.
   *
   * `maxSteps` bounds model calls, which is not the same budget: one reply can
   * carry an unbounded list of calls, so a single step could otherwise execute
   * thousands of tools before the step counter moved at all.
   */
  maxToolCallsPerStep?: number;
  /** Maximum tool invocations across one `send`. Defaults to {@link DEFAULT_MAX_TOOL_CALLS_PER_RUN}. */
  maxToolCallsPerRun?: number;
  /**
   * Distinct files one cycle may write when no gene constrains the round.
   * Defaults to {@link DEFAULT_WRITE_MAX_FILES}. A gene replaces this for the
   * round it applies to — in **either** direction, because a declared
   * constraint is what bounds a round that was told something, and a limit that
   * can only ever go up is not a limit.
   */
  maxWriteFiles?: number;
  /**
   * Wall-clock ceiling for one `send`, in milliseconds.
   *
   * Omitted/null means no whole-send deadline. Per-request/tool timers and
   * operator cancellation remain independent.
   */
  deadlineMs?: number | null;
  /**
   * Ceiling on the size of one reconstructed prompt, in UTF-8 bytes.
   * Defaults to {@link DEFAULT_MAX_CONTEXT_BYTES}.
   *
   * This is a **byte** budget, not a token budget: it bounds what this project
   * hands to a provider, and it deliberately claims nothing about the provider's
   * tokeniser or window size. It is also not a truncation policy — an over-size
   * prompt is refused with its actual size, because silently dropping messages
   * (especially a system or approval message) would change what the model is
   * answering without anyone being told.
   */
  maxContextBytes?: number;
  /**
   * Tool messages larger than this byte count are replaced in the projected
   * prompt with an `obs_recall` placeholder (D128 §九), so a session with a
   * few large results can keep working instead of failing `assertContextFits`.
   *
   * **Default: `32 * 1024` (32 KiB).** Chosen from a personal-agent test-suite
   * measurement of n=11 real tool calls (D128 §九·六 / `measure-tool-bytes.test.ts`):
   * 5/11 = 45% of tool results would project at 32 KiB, hitting the 18.9K / 40K /
   * 65K / 200K "mid-range" cases the projection exists to save while leaving the
   * < 256 B short shells, small JSONs, and small binary hex dumps untouched. 32 KiB
   * is `RECALL_MAX_BYTES` × 2, so "≥ 2 recall pages" is the boundary. **The n=11
   * sample is directional, not precise** — set this explicitly to refine once
   * DSH session data is available, or pass `Number.POSITIVE_INFINITY` to turn
   * projection off.
   *
   * Pass an integer ≥ 1 to enable, or `Number.POSITIVE_INFINITY` to keep the
   * projection off. A `0` or negative value is treated as off, not as
   * "project everything", because a placeholder for a one-byte tool result is
   * information loss dressed up as a budget control.
   */
  obsProjectionThreshold?: number;
  /**
   * Ceiling on the input-token count the provider may report before the run
   * stops. Defaults to {@link DEFAULT_MAX_CONTEXT_TOKENS}.
   *
   * Enforced from the provider's own `usage.inputTokens`, so this project needs
   * no tokeniser and makes no estimate. Two honest consequences: the first call
   * of a run has no measurement yet and is bounded only by `maxContextBytes`,
   * and a count can only stop the run one call after it was reported.
   */
  maxContextTokens?: number;
  /**
   * Per-model prompt windows, in tokens, keyed by the model name the provider
   * reports. `"*"` is the fallback for any model without an exact entry.
   *
   * A window here *replaces* {@link maxContextTokens} for that model — it is not
   * an extra limit — so a small-window model is not silently held to a large
   * global default. It bounds the token ceiling only: no byte ceiling is derived
   * from it, because turning tokens into bytes needs a bytes-per-token
   * assumption and this project does not estimate.
   */
  contextWindows?: Readonly<Record<string, number>>;
  /**
   * Optional host-supplied counter for the prompt about to be sent, which closes
   * the gap that makes the provider-based ceiling one call late.
   *
   * The intended implementation is a real tokenizer for the configured model, so
   * the count is exact. **No tokenizer is bundled**: the heuristic alternative
   * (characters divided by some constant) is deliberately not used as a default,
   * because an estimate that is wrong in either direction would silently replace
   * the honest "not measured yet" state with a confident-looking number. Supply
   * this only if you are supplying a counter you trust; its result is treated as
   * authoritative and is not cross-checked against the provider.
   *
   * It is called on every prompt build, so it must be cheap and must not throw
   * for valid input; a non-integer or negative result is refused loudly rather
   * than silently disabling the ceiling.
   */
  countPromptTokens?: (messages: readonly ChatMessage[]) => number;
  model?: string;
  systemPrompt?: string;
  /**
   * Curated capability prompts routed by scenario keywords (D81). Absent or empty
   * means no skill can match, which is the operator's "如果没有就不匹配" — the
   * intent fragment is still assembled.
   *
   * ⚠️ This exists as an injection point before any loader does, because without
   * it the safety property "the block counts toward the injected-bytes cap" cannot
   * be tested end to end: a hard-coded empty catalogue makes the block always
   * tiny, so removing it from the cap would keep every test green. Loading a JSON
   * catalogue from the agent home is the next step and needs path-safety review
   * under `security-config.ts`; the assembly does not change when it lands.
   */
  taskPromptSkills?: readonly TaskPromptSkill[];
  temperature?: number;
}

export const DEFAULT_MAX_TOOL_CALLS_PER_STEP = 8;
export const DEFAULT_MAX_TOOL_CALLS_PER_RUN = Infinity;
/**
 * The write budget for a round with **no gene applied**: unbounded is not a
 * default. A gene's own numbers replace these for the round it applies to, in
 * either direction — see `budgetFor` for why the default is not also a floor.
 */
export const DEFAULT_WRITE_MAX_FILES = 3;
export const DEFAULT_DEADLINE_MS = Infinity;
export const DEFAULT_MAX_CONTEXT_BYTES = 512 * 1024;
export const DEFAULT_MAX_CONTEXT_TOKENS = 131_072;

/**
 * Default byte threshold for `obsProjectionThreshold` (D128 §九·六).
 * 32 KiB = `RECALL_MAX_BYTES` × 2, so "≥ 2 recall pages" is the boundary.
 * The value is backed by a personal-agent test-suite measurement of n=11
 * real tool calls (5/11 = 45% projected at 32 KiB), but the n=11 sample
 * is directional, not precise. Operators refine this once DSH session
 * distribution is available; pass `Number.POSITIVE_INFINITY` to disable.
 */
export const DEFAULT_OBS_PROJECTION_THRESHOLD_BYTES = 32 * 1024;

export const DEFAULT_MAX_STEPS = Infinity;

/** Default home for the agent's own state, relative to the cwd. */
export const DEFAULT_AGENT_HOME = ".personal-agent";

/** Raised when the model kept requesting tools past the step budget. */
export class StepLimitError extends Error {
  readonly steps: number;

  constructor(steps: number) {
    super(`step limit reached after ${steps} model calls without a final answer`);
    this.name = "StepLimitError";
    this.steps = steps;
  }
}

/** Raised when one step or one send requested more tools than its budget allows. */
export class ToolBudgetError extends Error {
  readonly scope: "step" | "run";
  readonly limit: number;

  constructor(scope: "step" | "run", limit: number) {
    super(`tool budget exceeded: more than ${limit} tool calls in one ${scope}`);
    this.name = "ToolBudgetError";
    this.scope = scope;
    this.limit = limit;
  }
}

/** Raised when one `send` ran longer than its wall-clock ceiling. */
export class DeadlineExceededError extends Error {
  readonly deadlineMs: number;

  constructor(deadlineMs: number) {
    super(`run deadline exceeded after ${deadlineMs} ms`);
    this.name = "DeadlineExceededError";
    this.deadlineMs = deadlineMs;
  }
}

/** Raised when the reconstructed prompt would exceed its byte ceiling. */
export class ContextBudgetError extends Error {
  readonly bytes: number;
  readonly limit: number;
  /**
   * The caller's own wording, used as the whole message when present.
   *
   * ⚠️ D81: there are two distinct byte ceilings and they need different advice.
   * The whole-prompt ceiling (`assertContextFits`) is about history length, so its
   * message says "start a new session or shorten the history". The injected-block
   * ceiling (`maxContextBytes / 4`) is about the blocks re-sent every turn, so
   * telling the operator to start a new session would be useless — the blocks come
   * back on the next turn regardless — and it has to say *which* block to shorten.
   * Both are context-budget refusals and both must stay this named type, because
   * failure attribution branches on `instanceof ContextBudgetError`; a plain
   * `Error` would be classified `unknown` and lose the cause.
   */
  readonly detail?: string;

  constructor(bytes: number, limit: number, detail?: string) {
    super(
      detail ??
        `context budget exceeded: prompt is ${bytes} bytes, limit is ${limit} ` +
          `(a byte ceiling, not a token count — start a new session or shorten the history)`,
    );
    this.name = "ContextBudgetError";
    this.bytes = bytes;
    this.limit = limit;
    if (detail !== undefined) this.detail = detail;
  }
}

/**
 * Raised when the provider has already reported an input-token count above the
 * ceiling.
 *
 * This is a *measured* number, not an estimate: it is the count the provider
 * itself returned for the previous call, so no tokeniser is bundled and no
 * guess is made. The cost of that honesty is latency — the ceiling can only
 * stop the run one call after the count was reported, which is why the byte
 * ceiling exists as well.
 */
export class TokenBudgetError extends Error {
  readonly tokens: number;
  readonly limit: number;
  /**
   * Where the count came from. `host` is a counter supplied through
   * {@link RuntimeOptions.countPromptTokens} (a real tokenizer, if the host
   * wired one); `provider` is the usage a provider reported for an earlier call.
   * The distinction matters when reading the message: only one of them describes
   * the prompt that was about to be sent.
   */
  readonly source: "provider" | "host";

  constructor(tokens: number, limit: number, source: "provider" | "host" = "provider") {
    super(
      source === "host"
        ? `token budget exceeded: the host tokenizer counted ${tokens} tokens for this prompt, limit is ${limit}`
        : `token budget exceeded: the provider reported ${tokens} input tokens, limit is ${limit} ` +
          `(measured from the provider's own usage, not estimated — the byte ceiling covers growth since that report)`,
    );
    this.name = "TokenBudgetError";
    this.tokens = tokens;
    this.limit = limit;
    this.source = source;
  }
}

/**
 * UTF-8 bytes of the payload actually sent: message text plus tool-call names
 * and arguments. Counting only `content` would under-report the moment a model
 * requests a tool with a large argument.
 */
function promptBytes(messages: readonly ChatMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += Buffer.byteLength(message.content, "utf8");
    for (const call of message.toolCalls ?? []) {
      total += Buffer.byteLength(call.name, "utf8") + Buffer.byteLength(call.arguments, "utf8");
    }
  }
  return total;
}

/**
 * Reject a malformed window map at construction rather than letting a bad value
 * silently disable the ceiling it was meant to set.
 */
function validateContextWindows(windows: Readonly<Record<string, number>> | undefined): Readonly<Record<string, number>> | undefined {
  if (windows === undefined) return undefined;
  const entries = Object.entries(windows);
  if (entries.length === 0) return undefined;
  for (const [model, value] of entries) {
    if (model.trim() === "") throw new Error("contextWindows keys must be non-empty model names");
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`contextWindows["${model}"] must be a positive integer, got ${JSON.stringify(value)}`);
    }
  }
  return Object.freeze({ ...windows });
}

function positiveInt(name: string, value: number | undefined, fallback: number): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) {
    throw new Error(`${name} must be a positive integer, got ${String(value)}`);
  }
  return resolved;
}

/**
 * True only for an abort-shaped failure, so a real error is never relabelled as
 * a timeout. `AbortSignal.timeout()` rejects with `TimeoutError` while an
 * explicit `abort()` rejects with `AbortError`, so both count — the caller of
 * this predicate additionally proves *our* deadline was the one that fired.
 */
function isAbortError(error: unknown): boolean {
  return error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
}

/**
 * How much of each ceiling one send used, and what the ceiling was.
 *
 * Used and limit are both reported so the caller computes the remainder rather
 * than trusting a second, derived number to stay in step with the first.
 *
 * Read the token pair carefully: `inputTokens` is the provider's own count for
 * the **last model call of this send**, so it is a measurement of the past, not
 * a prediction for the next prompt. `promptBytes` likewise describes the last
 * prompt actually built.
 */
export interface RunBudget {
  stepsUsed: number;
  maxSteps: number;
  toolCallsUsed: number;
  maxToolCallsPerRun: number;
  promptBytes: number;
  maxContextBytes: number;
  /** Absent when no model reply has reported a count yet. */
  inputTokens?: number;
  maxContextTokens: number;
  /**
   * Count for the last prompt from the host tokenizer, when one was supplied.
   * This describes the prompt that was actually built, unlike {@link inputTokens},
   * which describes the provider's previous call.
   */
  predictedTokens?: number;
  /**
   * Provider-reported reasoning tokens for this send, when any reply reported them.
   * Already included in the provider's output count — this is a share marker, not
   * something to add to another total.
   */
  reasoningTokens?: number;
  elapsedMs: number;
  deadlineMs: number;
  /** Writes charged to this cycle, against the budget the round ran under (D18). */
  filesWritten?: number;
  filesWrittenLimit?: number;
  /**
   * Lines this cycle actually wrote. **Recorded, never limited** — the budget has
   * one axis, so this is blast radius for the operator and evidence for the
   * estimator, not a number the round can run out of.
   */
  linesWritten?: number;
}

/**
 * One-line rendering of a send's budget, for both CLI entry points.
 *
 * Two honesty rules are built in. A token count that was never measured prints
 * as such instead of showing a comfortable-looking remainder, and a measured
 * count above the ceiling prints how far over it is rather than a negative
 * "remaining" that reads like headroom.
 */
export function formatBudget(budget: RunBudget): string {
  const size = (n: number) => (n < 1024 ? `${n}B` : `${(n / 1024).toFixed(1)}KB`);
  const time = (n: number) => `${(n / 1000).toFixed(1)}s`;
  const measured = budget.inputTokens;
  // A host tokenizer judges the prompt that was sent; the provider's count judges
  // the call before it. Showing the host count when present, and never blending
  // the two into one number, keeps the line readable as evidence.
  const counted = budget.predictedTokens ?? measured;
  const basis = budget.predictedTokens === undefined ? "" : "(本机)";
  const tokens = counted === undefined
    ? `令牌 未测量/${budget.maxContextTokens}`
    : counted > budget.maxContextTokens
      ? `令牌 ${counted}/${budget.maxContextTokens}(超${counted - budget.maxContextTokens})${basis}`
      : `令牌 ${counted}/${budget.maxContextTokens}(剩${budget.maxContextTokens - counted})${basis}`;
  return `[步骤 ${budget.stepsUsed}/${Number.isFinite(budget.maxSteps)?budget.maxSteps:'不限'} · 工具 ${budget.toolCallsUsed}/${Number.isFinite(budget.maxToolCallsPerRun)?budget.maxToolCallsPerRun:'不限'}` +
    ` · prompt ${size(budget.promptBytes)}/${size(budget.maxContextBytes)} · ${tokens}` +
    // Printed only when a provider reported it. The whole point of this number is
    // that a two-word answer can still burn a thousand output tokens; hiding it is
    // what made the spend look inexplicable.
    (budget.reasoningTokens === undefined ? "" : ` · 推理 ${budget.reasoningTokens}`) +
    // Printed only once a write budget was established (the field is optional on
    // the type). Showing writes only when they happened keeps a read-only round's
    // budget line exactly as short as it was.
    (budget.filesWritten === undefined ? "" : ` · 写入 ${budget.filesWritten}/${budget.filesWrittenLimit} 文件 ${budget.linesWritten} 行`) +
    ` · 用时 ${time(budget.elapsedMs)}/${Number.isFinite(budget.deadlineMs)?time(budget.deadlineMs):'不限'}]`;
}

export interface SendResult {
  reply: ChatMessage;
  /** The applied gene's claims compared against the round, when a gene applied. */
  validation?: ValidationReport;
  /**
   * The recorded task state's steps compared against **this round's** evidence,
   * when a task state was recorded. Absent when none was.
   *
   * Scoped to the round and deliberately not folded into `evaluation.status`. The
   * asymmetry is the whole point: a gene is applied to one round, so its claims can
   * fairly decide that round; a task spans rounds, so a step met in round two reads
   * as unmet against round five's evidence. Downgrading a round for that would be
   * the system manufacturing a misleading verdict about itself — the same shape D62
   * refused to inject into the prompt. So this is reported, never gated on.
   */
  taskAssessment?: TaskStateAssessment;
  /** Reasoning trace of the final reply, when the provider exposed one. */
  reasoning?: string;
  usage: ChatUsage;
  model: string;
  /** Messages the model actually saw, including the new exchange. */
  history: ChatMessage[];
  /** Model calls made in this send. 1 means no tool was requested. */
  steps: number;
  /** Tool invocations executed in this send. */
  toolCalls: number;
  /** What this send consumed against each ceiling. */
  budget: RunBudget;
  /**
   * Number of leading messages this send's prompt replaced with a summary, so a
   * caller can say so instead of silently reading a shorter prompt as the whole
   * conversation. Undefined when nothing was compacted.
   */
  compactedMessages?: number;
  /** What this send was decided to be, before the model was called. */
  taskSpec: TaskSpec;
  /** The gene this send applied, when one was selected. */
  appliedGene?: { address: string; name: string };
  /** The PDRI cycle this send ran as. One send is exactly one cycle. */
  cycleId: string;
  /** The mechanical verdict on this cycle, with the facts it was read off. */
  evaluation: CycleEvaluation;
}

/**
 * The agent loop: load history, append the user turn, ask the adapter, execute
 * any tools it asks for, feed the results back, repeat until it stops asking.
 *
 * Tools run **sequentially, in the order the model requested them**, and each
 * result is appended before the next call starts. That is a deliberate first
 * cut: ordered execution makes the log trivially replayable, and correctness of
 * the transcript is worth more than throughput while the loop is young. A
 * concurrent pool with ordered commit can be slotted in behind `runToolCalls`
 * without changing the loop or the event shapes.
 *
 * The registry currently refuses side-effect tools; built-in reads enforce
 * sensitive-path policy and are validated against the tool's declared parameter
 * schema. Interactive approval is still pending. In-process tools remain trusted
 * code, not sandboxed plugins.
 *
 * Model calls (`maxSteps`), tools per step, tools per run, a wall-clock deadline,
 * a prompt byte ceiling, and a token ceiling taken from the provider's own
 * reported usage with an optional per-model window. The deadline reaches the
 * adapter as an abort signal, so a stalled provider is actually cut off; it
 * cannot, however, force-kill in-process code that ignores the signal — it stops
 * new work from starting rather than claiming a hard total-runtime guarantee.
 *
 * It does decide *what the tool sees*. Every tool invocation is handed a
 * rebuilt {@link ToolEnvironment} in which `HOME`, `USERPROFILE`, `TMP`, `TEMP`
 * and the per-user config directories point inside the agent's own home, and the
 * cwd is the workspace root. That environment is built in the constructor, so a
 * home that overlaps the operator's fails before a single tool can run.
 */
export class AgentRuntime {
  private readonly adapter: ModelAdapter;
  private readonly store: SessionStore;
  private readonly sessionId: string;
  private readonly workspaceRoot: string;
  private readonly home: string;
  private readonly protectedRoots: readonly string[];
  /** Runtime state that stays denied even inside an operator-granted root (D35). */
  private readonly protectedStateRoots: readonly string[];
  /**
   * Extra readable roots, read from the trust file on each step (D35).
   *
   * Not captured once at construction: qwen-code re-reads trust on every call,
   * and the reason applies here too. A session that snapshotted its permissions
   * would keep reading a tree the operator had since revoked, so the grant would
   * mean "readable until this conversation ends" rather than "readable now".
   */
  private readableRootsCache: readonly string[] = [];
  private readonly configuredProtectedRoots: readonly string[];
  /** Built once, at construction, so an unsafe home fails closed. */
  readonly toolEnvironment: ToolEnvironment;
  private readonly tools: ToolRegistry | undefined;
  private readonly maxSteps: number;
  private readonly maxToolCallsPerStep: number;
  private readonly maxToolCallsPerRun: number;
  private readonly deadlineMs: number;
  private readonly maxContextBytes: number;
  private readonly maxContextTokens: number;
  /** D128 §九 — `Number.POSITIVE_INFINITY` means "no projection" (default). */
  private readonly obsProjectionThreshold: number;
  private readonly contextWindows: Readonly<Record<string, number>> | undefined;
  private readonly countPromptTokens: ((messages: readonly ChatMessage[]) => number) | undefined;
  /** Count for the last prompt built, when a host tokenizer is supplied. */
  private lastPredictedTokens: number | undefined;
  /**
   * Model whose window applies right now: the requested one until a reply
   * arrives, then whatever the provider said it actually used.
   */
  private activeModel: string | undefined;
  /** Bytes of the prompt built for the most recent model call. */
  private lastPromptBytes = 0;
  /**
   * Input-token count the provider reported for the most recent call, or
   * `undefined` before the first reply of this session.
   *
   * The conversation only grows, so this is a measured lower bound for the next
   * prompt: if the provider already counted more than the ceiling, the next call
   * would only be larger.
   */
  private lastInputTokens: number | undefined;
  private readonly model: string | undefined;
  private readonly systemPrompt: string | undefined;
  /** The selected gene's injection block for the send in flight. */
  private genePrompt: string | undefined;
  /**
   * The request-derived prompt block: intent fragment plus a matched skill, if
   * one matched. Set per round from the TaskSpec and cleared in the same
   * `finally` that clears `genePrompt`, so it cannot leak into a later round.
   *
   * ⚠️ Lowest authority of the five system-prompt blocks — it is derived from
   * the request, and a matched skill's text may come from a curated catalogue
   * outside the product. `buildPrompt` therefore appends it last, after
   * `taskState`, so it cannot displace the product's, the library's or the
   * operator's text.
   */
  private taskPromptBlock: string | undefined;
  /**
   * The bytes of `taskPromptBlock` that came from outside the product — the matched
   * skill's prompt — and are therefore charged to the injected-block cap in
   * `buildPrompt`. The intent fragment is excluded on purpose: it is product-owned,
   * five compile-time constants, about 180 bytes, bounded. D82; see the cap comment
   * in `buildPrompt` for the measurement that forced the split.
   */
  private taskPromptExternalBytes = 0;
  private readonly taskPromptSkills: readonly TaskPromptSkill[] | undefined;
  /** Outcome row address for the send in flight; undefined = no round started. */
  private outcomeAddress: string | null | undefined;
  /** The request kind for the send in flight, so failures can be grouped (D16). */
  private outcomeSpec: { intent: TaskIntent; signals: readonly string[] } | undefined;
  /** Tools this round actually called, in order (D17). */
  private outcomeTools: string[] | undefined;
  /**
   * Whether drift, not the score, chose this round's gene (D108).
   *
   * Carried alongside the address for the same reason the address is: the outcome
   * row is the only place a round's provenance survives, and a gene picked at random
   * from the top-N must not be credited or blamed as though it had won on evidence.
   * `false` when no gene was applied, so the field never reads as "unknown".
   */
  private outcomeDrifted: boolean | undefined;
  /** Addresses that competed this round, for the counterfactual-replay record (D113). */
  private outcomeCandidates: readonly string[] | undefined;
  /** Cumulative writes for the cycle in flight (D18). */
  private writeLedger: LedgerState = { files: [], lines: 0 };
  private writeBudget: WriteBudget;
  /**
   * Whether this round's ceiling is still a guess being discovered rather than a
   * gene's commitment.
   *
   * The one raise lives on the road from "no gene" to "minted gene": there the
   * ceiling is a provisional estimate, and its first refusal is evidence the
   * estimate was too low, so the ceiling is widened once and the write runs.
   * Once a gene supplies a number that number is a commitment — hitting it is a
   * real failure, which is what makes the score mean anything and what the next
   * mint's statistic is for. A ceiling that yields every time could never be hit,
   * and a limit nothing ever hits measures nothing.
   */
  private provisionalCeiling = false;
  private readonly defaultWriteBudget: WriteBudget;
  private readonly geneStore: GeneStore | undefined;
  private readonly cycleStore: CycleStore | undefined;
  private readonly temperature: number | undefined;
  private prepared: Promise<void> | undefined;
  private busy = false;
  private readonly onActivity: ((event: RuntimeActivity) => void) | undefined;
  private readonly approve: ((prompt: string) => Promise<boolean>) | undefined;
  private readonly rules: readonly Rule[] | undefined;
  private readonly enforceTaskSpec: boolean;
  private activity(event: RuntimeActivity): void { try { this.onActivity?.(event); } catch { /* display must not corrupt execution */ } }

  constructor(options: AgentRuntimeOptions) {
    this.adapter = options.adapter;
    this.onActivity = options.onActivity;
    this.approve = options.approve;
    this.rules = options.rules;
    this.enforceTaskSpec = options.enforceTaskSpec ?? false;
    this.store = options.store;
    this.sessionId = options.sessionId;
    this.configuredProtectedRoots = Object.freeze([...(options.protectedRoots ?? [])]);
    let paths;
    try { paths = resolveRuntimePaths({ workspaceRoot: options.workspaceRoot ?? process.cwd(),
      agentHome: resolve(options.home ?? DEFAULT_AGENT_HOME), protectedRoots: this.configuredProtectedRoots }); }
    catch (error) { throw new UnsafeAgentHomeError((error as Error).message); }
    this.workspaceRoot = paths.workspaceRoot;
    this.home = paths.agentHome;
    const storeRoot = assertSafeStateDirectory(this.store.root, { protectedRoots: this.configuredProtectedRoots });
    this.protectedRoots = Object.freeze([...paths.protectedRoots, this.home, storeRoot]);
    // The subset that must stay unreadable even under an operator-granted
    // readable root: this runtime's own memory and logs. `paths.protectedRoots`
    // is intentionally excluded — it contains whole host trees such as
    // `%LOCALAPPDATA%`, which would refuse nearly every grantable directory.
    this.protectedStateRoots = Object.freeze([this.home, storeRoot]);
    this.toolEnvironment = buildToolEnvironment({
      workspaceRoot: this.workspaceRoot, agentHome: this.home,
      protectedRoots: this.configuredProtectedRoots,
    });
    this.tools = options.tools;
    this.maxSteps = options.maxSteps === undefined || options.maxSteps === Infinity ? Infinity : positiveInt("maxSteps", options.maxSteps, DEFAULT_MAX_STEPS);
    this.maxToolCallsPerStep = positiveInt("maxToolCallsPerStep", options.maxToolCallsPerStep, DEFAULT_MAX_TOOL_CALLS_PER_STEP);
    this.maxToolCallsPerRun = options.maxToolCallsPerRun === undefined || options.maxToolCallsPerRun === Infinity ? Infinity : positiveInt("maxToolCallsPerRun", options.maxToolCallsPerRun, DEFAULT_MAX_TOOL_CALLS_PER_RUN);
    this.writeBudget = {
      maxFiles: positiveInt("maxWriteFiles", options.maxWriteFiles, DEFAULT_WRITE_MAX_FILES),
      // Empty by design, and deliberately not an `options.*` knob. Forbidden paths
      // come from the applied gene, which is the layer that knows what this kind of
      // work must not touch; the runtime's defaults are arithmetic ceilings that
      // hold when no gene applies. A gene-less round therefore forbids nothing,
      // which is the behaviour every existing test pins.
      forbiddenPaths: [],
    };
    this.defaultWriteBudget = this.writeBudget;
    this.deadlineMs = options.deadlineMs === undefined || options.deadlineMs === null || options.deadlineMs === Infinity ? Infinity : positiveInt("deadlineMs", options.deadlineMs, DEFAULT_DEADLINE_MS);
    this.maxContextBytes = positiveInt("maxContextBytes", options.maxContextBytes, DEFAULT_MAX_CONTEXT_BYTES);
    this.maxContextTokens = positiveInt("maxContextTokens", options.maxContextTokens, DEFAULT_MAX_CONTEXT_TOKENS);
    // `positiveInt` rejects Infinity, so the `Infinity` case is inlined the same
    // way `maxSteps` and `deadlineMs` are handled in this constructor (D128 §九).
    this.obsProjectionThreshold = (() => {
      const value = options.obsProjectionThreshold;
      if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY; // explicit "off" wins
      if (value === undefined) return DEFAULT_OBS_PROJECTION_THRESHOLD_BYTES;
      if (!Number.isInteger(value) || value < 1) {
        throw new Error(`obsProjectionThreshold must be a positive integer or Infinity, got ${String(value)}`);
      }
      return value;
    })();
    this.contextWindows = validateContextWindows(options.contextWindows);
    this.countPromptTokens = options.countPromptTokens;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
    this.taskPromptSkills = options.taskPromptSkills;
    this.geneStore = options.geneStore;
    this.cycleStore = options.cycleStore;
    this.temperature = options.temperature;
  }

  get id(): string {
    return this.sessionId;
  }

  /** The agent's own home. Never the operator's. */
  get agentHome(): string {
    return this.home;
  }

  async ensureSession(): Promise<void> {
    await this.prepareToolDirectories();
    if (!(await this.store.exists(this.sessionId))) await this.store.create(this.sessionId);
  }

  /**
   * Create the agent's scratch directory before the first tool runs.
   *
   * A tool handed `TMP=<home>/tmp` cannot be expected to create it, and the
   * alternative — letting scratch land in whatever directory already exists — is
   * how a run ends up writing into the operator's profile.
   */
  private async prepareToolDirectories(): Promise<void> {
    this.prepared ??= (async () => {
      const paths = resolveRuntimePaths({ workspaceRoot: this.workspaceRoot, agentHome: this.home,
        tempRoot: this.toolEnvironment.env.TEMP, protectedRoots: this.configuredProtectedRoots });
      assertSafeStateDirectory(this.store.root, { protectedRoots: this.configuredProtectedRoots });
      await mkdir(paths.scratch, { recursive: true });
    })();
    return this.prepared;
  }

  async history(): Promise<ChatMessage[]> {
    return this.store.history(this.sessionId);
  }

  async send(input: string, signal?: AbortSignal): Promise<SendResult> {
    signal?.throwIfAborted();
    if (!input.trim()) throw new Error("empty input");
    if (this.busy) throw new Error("this runtime is already sending");
    this.busy = true;
    // The deadline is a real signal, not just a loop-boundary clock check: it has
    // to reach the adapter, otherwise a slow provider turns a bounded number of
    // calls into unbounded waiting. It cannot force-kill in-process code that
    // ignores the signal — it stops *starting* new work.
    const deadline = Number.isFinite(this.deadlineMs) ? AbortSignal.timeout(this.deadlineMs) : new AbortController().signal;
    const composed = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try { return await this.store.withWriter(this.sessionId, async () => {
      composed.throwIfAborted();
      await this.store.assertReady(this.sessionId);
      return this.sendTurn(input, composed);
    }); }
    catch (error) {
      // Net for failures that happen before the cycle starts (a refused spec, a
      // session that will not open, an over-size prompt): the gene was already
      // selected, so the round is still charged. After a cycle starts, sendTurn
      // journals its own verdict and this is a no-op — the address is consumed.
      await this.journalOutcome(this.readFailure(error, 0));
      // Only our own deadline may be relabelled: a caller's Ctrl+C stays a
      // cancellation, and a genuine failure is never dressed up as a timeout.
      if (deadline.aborted && !(signal?.aborted ?? false) && isAbortError(error)) {
        throw new DeadlineExceededError(this.deadlineMs);
      }
      throw error;
    }
    finally { this.busy = false; this.genePrompt = undefined; this.taskPromptBlock = undefined; this.taskPromptExternalBytes = 0; }
  }

  /**
   * Journal one outcome row for the round in flight, whichever way it ended.
   * Consuming the address makes a double journal impossible: the verdict and the
   * gene it belongs to are recorded exactly once per round.
   */
  private async journalOutcome(evaluation: CycleEvaluation, budgetRefusals = 0): Promise<void> {
    const address = this.outcomeAddress;
    const spec = this.outcomeSpec;
    const tools = this.outcomeTools;
    const drifted = this.outcomeDrifted;
    const candidates = this.outcomeCandidates;
    this.outcomeAddress = undefined;
    this.outcomeSpec = undefined;
    this.outcomeTools = undefined;
    this.outcomeDrifted = undefined;
    this.outcomeCandidates = undefined;
    if (address === undefined || !this.geneStore) return;
    // A round that ended in success while calling no tool made no claim about the
    // strategy it ran under: it is a chat answer, not work. The row is still written
    // (the log is the record of what happened) but marked ungraded, so the fold
    // leaves the gene's track record untouched.
    //
    // ⚠️ Narrow on purpose. The condition is success **and** no tool, so a refusal
    // (which lands on `partial`) and a pre-cycle failure keep their verdict and stay
    // charged — this must not become a way for a bad strategy to stop being blamed.
    // `tools` is `undefined` rather than empty on that failure path, which is a
    // second reason the success test comes first.
    const graded = !(evaluation.status === "success" && (tools?.length ?? 0) === 0);
    await this.geneStore.appendOutcome({
      address,
      succeeded: evaluation.status === "success",
      status: evaluation.status,
      failureClass: evaluation.failureClass,
      // The request kind is what makes a repeated failure recognizable later.
      ...(spec ? { intent: spec.intent, signals: spec.signals } : {}),
      // The proven tool order is what induction may build on — and nothing more.
      ...(tools ? { tools } : {}),
      // Only written when true, so rows from before drift keep their exact bytes and
      // a log reader can still tell "chosen by score" from "field did not exist yet"
      // by the absence of the key rather than by a value that was never recorded.
      ...(drifted ? { drifted } : {}),
      // The competition record for replay. Only written when more than one gene
      // competed: a single-candidate round has nothing to contrast, so recording a
      // one-element list would be bytes with no replay value.
      ...(candidates && candidates.length > 1 ? { candidates } : {}),
      // The round's write footprint, so `distill.ts`/`induct.ts` can size a gene's
      // budget from what rounds of this kind actually reached instead of from a
      // constant (D127). Written only when the round wrote something or was
      // stopped by the budget: a round that wrote nothing contributes nothing to
      // the measurement, and outcome rows are the log's growth hot spot.
      //
      // ⚠️ `budgetRefusals` must survive even when nothing was written, because
      // it is the flag that says the other two numbers are censored.
      //
      // `writeCeiling` rides along under the same condition, and is the ceiling
      // the round *ended* under — the one that refused, when anything was
      // refused, not the smaller one it started with. It is what lets
      // `measuredBudget` take the median over the limit as well as the demand, so
      // the estimate can come back **down**; a gene whose number could only ever
      // rise is a gene nobody can tighten. See `WriteObservation.ceilingFiles`.
      ...(this.writeLedger.files.length > 0 || budgetRefusals > 0
        ? {
          filesWritten: this.writeLedger.files.length,
          linesWritten: this.writeLedger.lines,
          ...(budgetRefusals > 0 ? { budgetRefusals } : {}),
          writeCeiling: { files: this.writeBudget.maxFiles },
        }
        : {}),
      evidence: evaluation.evidence,
      // Written only when false: rows already on disk predate this field and read as
      // graded, which is what they were.
      ...(graded ? {} : { graded: false }),
    });
  }

  /** Journal one PDRI event and advance the machine. Illegal moves throw first. */
  private async advance(cycle: CycleState, event: CycleEvent): Promise<CycleState> {
    const next = applyEvent(cycle, event);
    if (this.cycleStore) await this.cycleStore.append(this.sessionId, cycle.cycleId, event);
    return next;
  }

  private readFailure(error: unknown, steps: number): CycleEvaluation {
    return evaluateRun({ steps, toolCalls: 0, toolErrors: 0, failureClass: this.classifyFailure(error) });
  }

  /**
   * Name the cause from what actually threw, not from a message we hope is
   * stable: our own budget classes, an abort, and the adapter/validation
   * boundary are each distinguishable here.
   */
  private classifyFailure(error: unknown): FailureClass {
    if (isAbortError(error)) return "cancelled";
    if (error instanceof StepLimitError || error instanceof ToolBudgetError
      || error instanceof DeadlineExceededError || error instanceof ContextBudgetError
      || error instanceof TokenBudgetError || error instanceof WriteBudgetError) return "budget";
    const message = error instanceof Error ? error.message : "";
    if (message.startsWith("invalid model response") || message.startsWith("model ")) return "model";
    return "unknown";
  }

  private async sendTurn(input: string, signal?: AbortSignal): Promise<SendResult> {
    const text = input.trim();
    if (text.length === 0) throw new Error("empty input");

    // TaskSpec is decided before anything is written or sent: the mode comes
    // from the runtime, and a hard refusal (opt-in) must leave no trace, so it
    // runs before the session is even ensured.
    const taskSpec = buildTaskSpec(text, { mode: TASK_MODE });
    const verdict = assessTaskSpec(taskSpec, { enforce: this.enforceTaskSpec });
    if (verdict.blocked) throw new Error(verdict.reason ?? "task spec incomplete");

    // Gene selection (D14): the spec is the front door — its intent gates the
    // library and its signals score it. No match is an honest gene-less round.
    const applied = this.geneStore
      ? await this.geneStore.selectFor({ intent: taskSpec.intent, signals: taskSpec.signals, text: taskSpec.originalInput })
      : undefined;
    this.genePrompt = applied?.block;
    // The other half of the TaskSpec pipeline: the spec's intent — and a curated
    // skill when one actually matches the request — becomes prompt text. Before
    // this the spec only gated and scored gene selection, so "分析意图并匹配提示词
    // 或者组装一份好的提示词" stopped after 分析意图. The catalogue is empty for
    // now, which is literally the operator's "如果没有就不匹配": no skill is
    // injected, and the intent fragment still is.
    // ⚠️ D84: the catalogue comes from the agent home unless a caller injected one
    // — the same shape as `loadConstraints(this.home)` in `buildPrompt`. One small
    // file read per turn, from a directory the file tools cannot write by location
    // (`protectedRoots`, D50), so re-reading it adds no self-escalation surface.
    // An injected catalogue wins outright rather than merging with the disk one:
    // two sources for a single routing decision is how an operator stops being able
    // to tell which skill fired.
    // ⚠️ D101: this now goes through the skill seam instead of importing the
    // loader directly, so a provider can be registered without editing this file.
    // `listSkills` takes the NEAREST provider's catalogue and does not merge,
    // which is what keeps the paragraph above true — see its own doc comment.
    const skillCatalogue = this.taskPromptSkills ?? (await listSkills(this.home));
    this.taskPromptBlock = assembleTaskPrompt(taskSpec, skillCatalogue);
    // ⚠️ D82: only the skill half is charged to the injected cap, so measure it
    // instead of estimating it. Assembling against an empty catalogue yields exactly
    // the intent fragment, and the difference is the external part. Note this is a
    // real second caller of `assembleTaskPrompt` with `[]`, not a test-only
    // convenience — which is also why the fragment-only path has to stay correct.
    this.taskPromptExternalBytes =
      Buffer.byteLength(this.taskPromptBlock ?? "", "utf8") -
      Buffer.byteLength(assembleTaskPrompt(taskSpec, []) ?? "", "utf8");
    // Set before anything can throw past this point: whichever way the round
    // ends, an attempted round journals an outcome. A refused spec (above)
    // never reaches here, so a hard refusal still leaves no trace.
    this.outcomeAddress = applied?.address ?? null;
    this.outcomeDrifted = applied?.drifted ?? false;
    this.outcomeCandidates = applied?.candidates;
    this.outcomeSpec = { intent: taskSpec.intent, signals: taskSpec.signals };
    this.outcomeTools = [];
    // A fresh cycle starts with an empty ledger. A gene's constraints bound the
    // round; with no gene applied the runtime default still applies, because
    // "unbounded" is not a safe default (D18).
    this.writeLedger = { files: [], lines: 0 };
    // A gene's number is a commitment; with no gene the ceiling is still being
    // discovered, and only there may a refusal raise it (see `provisionalCeiling`).
    // Read off the SAME expression that sizes the budget, so the two cannot
    // disagree: the first version tested `applied === null`, and a gene-less round
    // leaves `applied` *undefined* (line 891), so the flag read "committed" for
    // every round and the raise never fired at all.
    const geneConstraints = applied?.constraints ?? null;
    this.writeBudget = budgetFor(geneConstraints, this.defaultWriteBudget);
    this.provisionalCeiling = geneConstraints === null;

    await this.ensureSession();
    signal?.throwIfAborted();
    // Until a reply says otherwise, the requested model is the one whose window
    // applies — otherwise the first call of every send would silently fall back
    // to the global ceiling no matter what was configured for this model.
    this.activeModel = this.model ?? this.adapter.defaultModel;
    // Refuse an over-size prompt *before* recording the user turn. A refusal must
    // leave no trace: writing a turn that can never be answered would leave the
    // session looking stuck, and every later send would fail the same way.
    this.assertContextFits(await this.buildPrompt({ role: "user", content: text }));
    // Identity for this send: every turn it writes carries it, so a later reader
    // can tell which run a turn belongs to without a separate run event.
    const runId = randomUUID();
    await this.store.appendMessage(this.sessionId, { role: "user", content: text }, { runId, step: 0 });

    // The PDRI cycle opens here, not earlier: a refusal above must leave no
    // trace, and this is the first point at which the round is genuinely
    // committed — the user turn is durable, so the work it asks for exists.
    let cycle = startCycle(runId, Date.now());

    const usage: ChatUsage = { inputTokens: 0, outputTokens: 0 };
    let reasoningTokens: number | undefined;
    let reasoning: string | undefined;
    const startedAt = Date.now();
    let model = this.adapter.defaultModel;
    let steps = 0;
    let toolCalls = 0;
    let toolErrors = 0;
    // The third number, kept off the success axis (D127). It is journaled so the
    // budget estimate can learn from real demand, and deliberately not fed into
    // `evaluateRun`: see `runToolCalls` for why the two are different lessons.
    let budgetRefusals = 0;

    try {
    cycle = await this.advance(cycle, { type: "execute-start", at: Date.now() });

    while (true) {
      const finalizing = steps >= this.maxSteps;
      signal?.throwIfAborted();
      const messages = await this.buildPrompt();
      if(finalizing)messages.push({role:'user',content:'The operator-configured step limit has been reached. Do not call tools. Give a final text summary of verified completed work, remaining work and blockers. Do not claim the entire task is complete unless supported by observed results.'});
      // Checked every step as well: the prompt grows with each tool result, so a
      // prompt that fit at step one is no guarantee at step five.
      this.assertContextFits(messages);
      signal?.throwIfAborted();
      this.activity({ type: "model" });
      const response = await this.adapter.chat(
        {
          messages,
          ...(this.tools && !finalizing ? { tools: this.tools.definitions() } : {}),
          ...(this.model ? { model: this.model } : {}),
          ...(this.temperature === undefined ? {} : { temperature: this.temperature }),
        },
        signal,
      );
      signal?.throwIfAborted();
      validateResponse(response);
      if(finalizing && response.toolCalls.length)throw new StepLimitError(steps);
      steps += 1;
      model = response.model;
      // The window now follows the model the provider actually used.
      this.activeModel = response.model;
      usage.inputTokens += response.usage.inputTokens;
      usage.outputTokens += response.usage.outputTokens;
      if (response.usage.reasoningTokens !== undefined) {
        reasoningTokens = (reasoningTokens ?? 0) + response.usage.reasoningTokens;
      }
      // The final reply's trace is what explains the answer the operator is about
      // to read; traces from earlier steps are dropped rather than accumulated,
      // because a tool loop's intermediate reasoning is not what anyone is reading.
      if (response.reasoning !== undefined && response.reasoning !== "") reasoning = response.reasoning;
      if (reasoningTokens !== undefined) usage.reasoningTokens = reasoningTokens;
      this.lastInputTokens = response.usage.inputTokens;

      if (response.content.trim() === "" && response.toolCalls.length === 0) {
        // Persisting this would leave a blank assistant turn in the transcript,
        // which replays as the model having said nothing at all.
        throw new Error(`model ${response.model} returned neither content nor tool calls`);
      }

      // Budgets are checked before the assistant turn is persisted. Recording a
      // request and then refusing to answer it would leave exactly the dangling
      // tool group that `/recover` exists to clean up — a refusal must leave no
      // trace of work that never started.
      if (response.toolCalls.length > this.maxToolCallsPerStep) {
        throw new ToolBudgetError("step", this.maxToolCallsPerStep);
      }
      if (toolCalls + response.toolCalls.length > this.maxToolCallsPerRun) {
        throw new ToolBudgetError("run", this.maxToolCallsPerRun);
      }

      const assistant: ChatMessage = { role: "assistant", content: response.content };
      if (response.toolCalls.length > 0) assistant.toolCalls = response.toolCalls;
      await this.store.appendMessage(this.sessionId, assistant, { model: response.model, runId, step: steps });
      await this.store.appendUsage(this.sessionId, response.usage);

      if (response.toolCalls.length === 0) {
        signal?.throwIfAborted();
        const compaction = await this.store.compaction(this.sessionId);
        const covered = compaction ? Math.min(compaction.covers, (await this.store.history(this.sessionId)).length) : 0;
        // Review: the verdict is read off what the round mechanically did, and
        // then the applied gene's claims are compared against that same record.
        // A claim that was contradicted makes the round partial at best — the
        // gene said what proof would look like and the proof is not there.
        const evaluation = evaluateRun({ steps, toolCalls, toolErrors, failureClass: null, reply: response.content, prompt: text, budgetRefusals, filesWritten: this.writeLedger.files });
        const completionEvaluation = finalizing ? {...evaluation,status:'partial' as const,evidence:[...evaluation.evidence,'Configured step cap reached; summary is not task completion.']} : evaluation;
        // One evidence object, named, and read by both consumers. Writing the pair
        // out twice would let the gene's claims and the task's claims be judged
        // against different facts about the same round.
        const roundEvidence = {
          filesWritten: this.writeLedger.files,
          tools: this.outcomeTools ?? [],
        };
        const validation = applied ? checkValidation(applied.validation, roundEvidence) : null;
        // Read here rather than reusing what `buildPrompt` saw: the model may have
        // written task state during this very round, and reusing the earlier copy
        // would assess the state as it was before the round changed it.
        const recordedState = await this.store.taskState(this.sessionId);
        const taskAssessment = recordedState === undefined
          ? undefined
          : assessTaskState(recordedState.steps, roundEvidence);
        const verdict = validation && validation.failed.length > 0
          ? {
            ...evaluation,
            status: "partial" as const,
            evidence: [...evaluation.evidence, ...validationEvidence(validation)],
          }
          : validation
            ? { ...completionEvaluation, evidence: [...completionEvaluation.evidence, ...validationEvidence(validation)] }
            : completionEvaluation;
        cycle = await this.advance(cycle, { type: "review-ready", at: Date.now(), evaluation: verdict });
        cycle = await this.advance(cycle, { type: "integrate-ready", at: Date.now() });
        await this.journalOutcome(verdict, budgetRefusals);
        cycle = await this.advance(cycle, { type: "complete", at: Date.now() });
        return {
          reply: assistant,
          usage,
          model,
          taskSpec,
          cycleId: runId,
          evaluation: verdict,
          ...(applied ? { appliedGene: { address: applied.address, name: applied.name } } : {}),
          ...(validation ? { validation } : {}),
          ...(taskAssessment === undefined ? {} : { taskAssessment }),
          ...(reasoning === undefined ? {} : { reasoning }),
          // `buildPrompt`, not `store.history`: this field means "what the model
          // saw", which includes the system prompt; the persisted log does not.
          history: await this.buildPrompt(),
          steps,
          toolCalls,
          ...(covered > 0 ? { compactedMessages: covered } : {}),
          budget: {
            stepsUsed: steps,
            maxSteps: this.maxSteps,
            toolCallsUsed: toolCalls,
            maxToolCallsPerRun: this.maxToolCallsPerRun,
            promptBytes: this.lastPromptBytes,
            maxContextBytes: this.maxContextBytes,
            ...(this.lastInputTokens === undefined ? {} : { inputTokens: this.lastInputTokens }),
            maxContextTokens: this.tokenCeiling(),
            ...(this.lastPredictedTokens === undefined ? {} : { predictedTokens: this.lastPredictedTokens }),
            ...(reasoningTokens === undefined ? {} : { reasoningTokens }),
            elapsedMs: Date.now() - startedAt,
            deadlineMs: this.deadlineMs,
            filesWritten: this.writeLedger.files.length,
            filesWrittenLimit: this.writeBudget.maxFiles,
            linesWritten: this.writeLedger.lines,
          },
        };
      }

      const executed = await this.runToolCalls(response.toolCalls, signal, runId, steps);
      toolCalls += executed.calls;
      toolErrors += executed.errors;
      budgetRefusals += executed.budgetRefusals;
    }
    }
    catch (error) {
      // Every ending closes the cycle: an interrupted round that stayed
      // "executing" would be indistinguishable from one still running.
      const evaluation = evaluateRun({
        steps, toolCalls, toolErrors, failureClass: this.classifyFailure(error),
      });
      await this.advance(cycle, { type: "fail", at: Date.now(), evaluation });
      await this.journalOutcome(evaluation, budgetRefusals);
      throw error;
    }
  }

  async totals(): Promise<ChatUsage> {
    return this.store.totals(this.sessionId);
  }

  /** Execute this step's calls in model order, recording each one as it lands. */
  private async runToolCalls(
    calls: readonly ToolCall[],
    signal: AbortSignal | undefined,
    runId: string,
    step: number,
  ): Promise<{ calls: number; errors: number; budgetRefusals: number }> {
    // Re-read on every step rather than caching for the session, so revoking a
    // root takes effect on the next step instead of the next conversation.
    try {
      this.readableRootsCache = await readTrustedRoots(this.home);
    } catch (error) {
      // A corrupt or unreadable trust file must not widen anything. Failing
      // closed here keeps reads confined, which is the safe direction.
      this.readableRootsCache = [];
      await this.store.appendAudit(this.sessionId, {
        tool: "*", decision: "denied",
        reason: `trust file could not be read; readable roots ignored: ${(error as Error).message}`,
      });
    }
    const context: ToolContext = {
      workspaceRoot: this.workspaceRoot,
      toolEnvironment: this.toolEnvironment,
      protectedRoots: this.protectedRoots,
      protectedStateRoots: this.protectedStateRoots,
      // Derived here, never passed in by a caller. The only rule shape that means
      // "the operator chose the widest tier" is an ADMIN-tier allow on every tool,
      // which is exactly what `tiers.ts` pins `full-access.allow-all` to. Config
      // rules are pinned to WORKSPACE and a `tier` key in JSON is a hard error
      // (`config.ts`), so neither the model nor a cloned repository can reach this.
      unrestrictedWrites: (this.rules ?? []).some((rule) => rule.tier === RULE_TIERS.ADMIN && rule.tool === "*" && rule.decision === "allow"),
      readableRoots: this.readableRootsCache,
      ...(signal ? { signal } : {}),
      ...(this.approve ? { approve: this.approve } : {}),
      ...(this.rules ? { rules: this.rules } : {}),
      audit: (event) => this.store.appendAudit(this.sessionId, event).then(() => undefined),
    };
    let errors = 0;
    // Kept apart from `errors` on purpose (D127). A write-budget refusal is not a
    // tool failure: the tool never ran, nothing broke, and the round is still
    // doing exactly what it was asked. Folding the two together charged the
    // applied gene for a budget that was mis-sized — the gene's quality record
    // then said "this strategy did not work" when the truth was "this round was
    // given too little room". Two different lessons, and only one of them is
    // about the strategy.
    let budgetRefusals = 0;
    // How many times this round corrected an under-sized ceiling. Local rather
    // than journaled: the raise's whole effect is the footprint it lets through,
    // and `filesWritten` already records that. The number that *is* journaled is
    // the ceiling it ended under, because the estimator reads that one. A field
    // nothing reads would be the same defect as a constraint nothing enforces.
    let ceilingRaised = 0;
    let index = 0;
    for (const call of calls) {
      const position = index++;
      this.outcomeTools?.push(call.name);
      // Write budget, checked before the tool runs. A refusal here means the
      // write never happened, so it cannot leave a partially written file or a
      // dangling tool correlation behind — the same rule the count budgets above
      // follow. The refusal is recorded as a failed tool result rather than
      // thrown, so the model sees it and one over-budget call cannot abort a
      // round that has other work left to do. The round's *first* refusal never
      // reaches the model at all: it raises the ceiling and the write runs, which
      // is why the code below branches before it starts recording anything.
      const attempt = readWriteAttempt(call.name, call.arguments);
      if (attempt !== null) {
        const decision = checkWrite(this.writeLedger, attempt, this.writeBudget);
        // The one raise, and only while the ceiling is still being discovered.
        // With no gene applied the ceiling is a provisional estimate, so its first
        // refusal is read as what it is — evidence the estimate was too low — and
        // the ceiling is widened to cover exactly this write, which then runs. A
        // gene-applied round gets no raise: there the number is a commitment, and
        // hitting it is the real failure that the score and the next mint's
        // statistic exist for. Either way the model only ever sees a refusal that
        // stood, and only that reaches `budgetRefusals`.
        const widened = decision.allowed || !this.provisionalCeiling || ceilingRaised > 0
          ? null
          : raiseFor(this.writeLedger, attempt, this.writeBudget);
        if (widened !== null) {
          ceilingRaised += 1;
          this.writeBudget = widened;
          await this.store.appendAudit(this.sessionId, {
            tool: call.name, decision: "allowed", cause: "budget",
            reason: `write budget raised to ${widened.maxFiles} file(s): ${decision.reason ?? "the ceiling refused this write"}`,
          });
        } else if (!decision.allowed) {
          budgetRefusals += 1;
          this.activity({ type: "tool-start", name: call.name, callId: call.id, arguments: activityText(call.arguments) });
          this.activity({ type: "tool-end", name: call.name, callId: call.id, isError: true, content: activityText(`refused: ${decision.reason}`) });
          await this.store.appendAudit(this.sessionId, {
            tool: call.name, decision: "denied", cause: "budget", reason: `write budget: ${decision.reason}`,
          });
          await this.store.appendMessage(
            this.sessionId,
            { role: "tool", content: `refused: ${decision.reason}`, toolCallId: call.id },
            { runId, step, isError: true },
          );
          continue;
        }
      }
      // Complete pending tool correlations even after cancellation, but never start another executor.
      let result;
      if (signal?.aborted) result = { content: "cancelled: tool was not executed", isError: true };
      else {
        this.activity({ type: "tool-start", name: call.name, callId: call.id, arguments: activityText(call.arguments) });
        result = signal?.aborted ? { content: "cancelled: tool was not executed", isError: true }
          : this.tools ? await this.tools.execute(call, context)
          : { content: `no tools are configured, cannot run ${call.name}`, isError: true };
        this.activity({ type: "tool-end", name: call.name, callId: call.id, isError: result.isError === true, content: activityText(result.content) });
      }
      // One line, not three (ADR-0001): the assistant turn above already recorded
      // what was requested, so this message is the whole record of what came back.
      if (result.isError === true) errors += 1;
      // Only a write that actually happened is charged. A failed write consumed
      // no budget, so the ledger stays a record of the workspace, not of intent.
      else if (attempt !== null) this.writeLedger = chargeWrite(this.writeLedger, attempt, position);
      await this.store.appendMessage(
        this.sessionId,
        { role: "tool", content: result.content, toolCallId: call.id },
        { runId, step, isError: result.isError === true },
      );
    }
    signal?.throwIfAborted();
    return { calls: calls.length, errors, budgetRefusals };
  }

  private assertContextFits(messages: readonly ChatMessage[]): void {
    const bytes = promptBytes(messages);
    this.lastPromptBytes = bytes;
    if (bytes > this.maxContextBytes) throw new ContextBudgetError(bytes, this.maxContextBytes);
    const ceiling = this.tokenCeiling();
    // A host tokenizer can judge the prompt about to be sent, which the provider's
    // report for the *previous* call cannot. Checked first for that reason.
    if (this.countPromptTokens) {
      const counted = this.countPromptTokens(messages);
      if (!Number.isSafeInteger(counted) || counted < 0) {
        throw new Error(`countPromptTokens must return a non-negative integer, got ${JSON.stringify(counted)}`);
      }
      this.lastPredictedTokens = counted;
      if (counted > ceiling) throw new TokenBudgetError(counted, ceiling, "host");
    }
    // Measured fallback: when the provider has already counted more than the
    // ceiling, refuse without spending another call on it.
    const measured = this.lastInputTokens;
    if (measured !== undefined && measured > ceiling) {
      throw new TokenBudgetError(measured, ceiling, "provider");
    }
  }

  /**
   * Token ceiling for the model in play.
   *
   * The exact entry wins over `"*"`, which wins over the global default. A
   * window replaces the global value rather than adding to it: a provider that
   * reports a 32k model must not be held to a 128k default just because the
   * default was the number someone typed first.
   */
  private tokenCeiling(): number {
    const windows = this.contextWindows;
    const model = this.activeModel;
    if (windows && model) {
      const exact = windows[model];
      if (exact !== undefined) return exact;
      const wildcard = windows["*"];
      if (wildcard !== undefined) return wildcard;
    }
    return this.maxContextTokens;
  }

  /**
   * Build the message list the model sees.
   *
   * A summary is an index, not a replacement. User and assistant messages stay
   * verbatim, because a rewritten summary can drop a path, an error, or a command.
   * Only tool results inside the covered range are omitted: they are the bulky,
   * reproducible part. The latest tool round is never covered, because `covers`
   * is the message count observed before the current send.
   *
   * The summary text itself is never truncated or paraphrased. An altered summary
   * would make the recorded boundary a lie about what the model was told.
   */
  private async buildPrompt(extra?: ChatMessage): Promise<ChatMessage[]> {
    // ponytail: store.history / loadConstraints / store.latestMarks are
    // re-read on every call, even though pre-flight (sendTurn:916) and the
    // first model iteration (sendTurn:946) produce the same content. The
    // constraints read is intentionally NOT cached — the operator can edit
    // constraints.json mid-conversation and expect the next turn to reflect
    // it (the comment immediately below documents this contract). History
    // and marks *do* change between the pre-flight and the first iteration
    // (the user turn is appended in between), so caching across that
    // boundary would diverge from the persisted log. Net cost per send:
    // 1 (pre-flight) + N (model loop) + 1 (journal) = N+2 history reads.
    // Audit 2026-10-09 §2.3 priority 5 weighed the refactor against a 1/(N+2)
    // saving (not 50% as the audit claimed — the 50% is per-pair, not per-
    // round) and concluded the refactor is not worth the semantic risk. Add
    // a session-level cache here when a long-session profile proves this
    // is a real bottleneck; until then, YAGNI.
    const past = await this.store.history(this.sessionId);
    // The applied gene rides in the system prompt: test-time evolution means
    // the selected strategy is context, never a rule the model is trusted to obey.
    // Standing operator constraints ride there for the same reason, and are
    // re-read every call so an edit mid-conversation applies on the next turn —
    // the defect being fixed is a constraint stated in turn 3 still sitting at
    // position 3 in turn 300. They are appended *after* `systemPrompt` rather
    // than ahead of it: operator text must not prime the model before the
    // product's own safety text. The anti-dilution property comes from the system
    // message being first in the conversation, not from its internal order.
    const constraints = formatConstraintsForPrompt(await loadConstraints(this.home));
    // Task state rides after the operator's constraints: of the blocks it carries
    // less authority — `systemPrompt` is the product's, `genePrompt` is the
    // library's, `constraints` is the operator's, and this one is the task's own
    // record of where it got to. The request-derived block (intent fragment plus a
    // matched skill) rides last of all, below even this one: it is assembled from
    // the request and a skill's text can come from a catalogue outside the product.
    // One pass over the log yields both "latest wins" marks; reading them
    // separately would read the whole session file twice per model call.
    const marks = await this.store.latestMarks(this.sessionId);
    const recorded = marks.taskState;
    const taskState = recorded === undefined ? undefined : formatTaskStateForPrompt(recorded.state, recorded.steps);
    // Both blocks are re-sent on every call, so together they are pure per-turn
    // overhead. Each is individually capped at write time, but two individually
    // legal blocks can still add up to more than a small `maxContextBytes` leaves
    // room for — and that failure would arrive as a whole-turn refusal, since
    // exceeding `maxContextBytes` refuses rather than truncates. One quarter of the
    // budget is the ceiling: at the default 512 KiB that is 131072 bytes, which two
    // maximum-size blocks (about 66000) never reach, so the default configuration is
    // never tripped by this check. It bites only when an operator lowers
    // `maxContextBytes`, which is exactly when the sum needs checking. One eighth
    // would be wrong: 65536 at the default collides with two maximum-size blocks.
    // ⚠️ Only the *external* part of the request-derived block counts toward this
    // cap (D82, correcting D81's "it must count in full"). The block has two halves
    // with different provenance: the intent fragment is product-owned — five
    // compile-time constants, about 180 bytes, bounded — while a matched skill's
    // prompt comes from a curated catalogue outside the product and is unbounded.
    // The cap exists for the second one. D81 charged both, and measuring showed the
    // consequence rather than leaving it argued: any `maxContextBytes` below roughly
    // 720 then refuses *every* turn, because a quarter of it cannot hold 180 bytes,
    // and the refusal blames the long-term constraints and the task state, which in
    // that situation are both zero bytes. Exempting the fragment restores "an
    // operator may lower maxContextBytes" without opening the bypass the cap exists
    // to prevent — the unbounded half is still charged, in full, byte for byte.
    const taskPromptBytes = Buffer.byteLength(this.taskPromptBlock ?? "", "utf8");
    const injectedBytes =
      Buffer.byteLength(constraints ?? "", "utf8") +
      Buffer.byteLength(taskState ?? "", "utf8") +
      this.taskPromptExternalBytes;
    const injectedCap = Math.floor(this.maxContextBytes / 4);
    if (injectedBytes > injectedCap) {
      // ⚠️ A named ContextBudgetError, not a plain Error (D81). Failure
      // attribution branches on `instanceof ContextBudgetError`; a plain Error
      // here would be classified `unknown` and the real cause would be lost. The
      // detail wording is this method's own because the advice differs: starting a
      // new session does not help, since these blocks are re-sent every turn.
      throw new ContextBudgetError(
        injectedBytes,
        injectedCap,
        `注入块合计 ${injectedBytes} 字节（长期约束 ${Buffer.byteLength(constraints ?? "", "utf8")} + 任务状态 ` +
          `${Buffer.byteLength(taskState ?? "", "utf8")} + 本轮提示 ${taskPromptBytes}（其中计入上限的外部部分 ${this.taskPromptExternalBytes} 字节；产品自有的意图片段不计入，它有编译期上界）），超过 maxContextBytes 的四分之一即 ${injectedCap} 字节；` +
          `请缩短其中最大的一块，或调高 maxContextBytes。不会截断；开新会话也没用，这些块每轮都会重新发送。`,
      );
    }
    const systemText = [this.systemPrompt, this.genePrompt, constraints, taskState, this.taskPromptBlock].filter((part) => part !== undefined && part !== "").join("\n\n");
    const system: ChatMessage[] = systemText === "" ? [] : [{ role: "system", content: systemText }];
    // Two projection passes, in this order (D128 §九, on the order see
    // `projectOversizedToolResults`'s own header):
    //   1. **Compaction first.** Replaces covered tool messages with a small
    //      placeholder that carries the size of the *original* content.
    //   2. **Size projection second.** Replaces individual tool messages
    //      bigger than `obsProjectionThreshold` with a placeholder that
    //      carries their size. Already-compacted messages have small content
    //      and so are no-ops of this pass; running the other order would
    //      leave the compaction pass describing a placeholder's bytes instead
    //      of the original's.
    const compaction = marks.compaction;
    const covered = compaction && compaction.covers > 0 ? Math.min(compaction.covers, past.length) : 0;
    const summary: ChatMessage | undefined = compaction && compaction.covers > 0
      ? {
          role: "system",
          content: `Earlier tool results were omitted after message ${covered}. ` +
            `User and assistant messages below stay verbatim. The full transcript is still in the session log.\n\n${compaction.summary}`,
        }
      : undefined;
    const afterCompaction = past.map((message, index) =>
      index < covered && message.role === "tool"
        ? { ...message, content: omittedResultPlaceholder(message.toolCallId, message.content) }
        : message);
    const projected = projectOversizedToolResults(afterCompaction, this.obsProjectionThreshold);
    const visible = summary ? [summary, ...projected] : projected;
    return extra ? [...system, ...visible, extra] : [...system, ...visible];
  }

  /**
   * Summarize the conversation so far and record how much of it that summary
   * represents, then return the new boundary.
   *
   * The summary is produced by a dedicated model call that is given **no tools**,
   * so compaction cannot itself start work, and the call is not persisted as a
   * turn: only the `summary` event is appended. An empty summary or one that
   * comes back with tool calls is refused before anything is written, because a
   * boundary that suppresses messages in exchange for nothing is data loss with a
   * receipt.
   */
  async compact(signal?: AbortSignal): Promise<{ covers: number; summaryLength: number }> {
    if (this.busy) throw new Error("a send is in flight; compaction runs between sends");
    this.busy = true;
    try {
      await this.ensureSession();
      // Fail before spending a model call: the store refuses this at write time
      // too, but paying for a summary that cannot be recorded is waste.
      const pending = await this.store.pendingTools(this.sessionId);
      if (pending.length > 0) {
        throw new Error(`refusing to summarize while ${pending.length} tool result(s) are missing; complete or recover the batch first`);
      }
      const history = await this.store.history(this.sessionId);
      if (history.length === 0) throw new Error("nothing to compact");
      const previous = await this.store.compaction(this.sessionId);
      const from = previous ? Math.min(previous.covers, history.length) : 0;
      const uncovered = history.slice(from);
      const system: ChatMessage[] = this.systemPrompt ? [{ role: "system", content: this.systemPrompt }] : [];
      const instruction: ChatMessage = {
        role: "user",
        content: [
          "Summarize the conversation below for your own future reference.",
          "Preserve, without inventing anything: decisions and their reasons, file paths and symbols named,",
          "tool results that mattered, errors and how they were resolved, and anything still unresolved.",
          "Do not add commentary, do not answer the conversation, and do not call any tool.",
          "Write the summary only; it will be shown to you in later turns verbatim.",
        ].join(" "),
      };
      const carried: ChatMessage[] = previous
        ? [{ role: "system", content: `Previous summary (already covers the earlier part):\n\n${previous.summary}` }]
        : [];
      const response = await this.adapter.chat({ messages: [...system, ...carried, ...uncovered, instruction] }, signal);
      validateResponse(response);
      if (response.toolCalls.length > 0) throw new Error("compaction asked for a tool; refusing to record a summary produced by an unexpected call");
      const summary = response.content.trim();
      if (summary === "") throw new Error("compaction produced an empty summary; nothing was recorded");
      // `history.length` is this session's own count, so the boundary records what
      // was actually covered rather than what the caller believed was covered.
      const event = await this.store.appendSummary(this.sessionId, { covers: history.length, summary });
      return { covers: event.covers, summaryLength: summary.length };
    } finally {
      this.busy = false;
    }
  }
}
