import { mkdir } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";

import type { ChatMessage, ChatUsage, ModelAdapter, ToolCall } from "./types.ts";
import type { SessionStore } from "./session-store.ts";
import type { ToolContext, ToolRegistry } from "./tools.ts";
import { buildToolEnvironment, UnsafeAgentHomeError } from "./tool-environment.ts";
import type { ToolEnvironment } from "./tool-environment.ts";
import { resolveRuntimePaths, assertSafeStateDirectory } from "./security-config.ts";

import { validateResponse } from "./response-validation.ts";

export interface RuntimeActivity { type: "model" | "tool-start" | "tool-end"; name?: string; isError?: boolean; }
export interface AgentRuntimeOptions {
  onActivity?: (event: RuntimeActivity) => void;
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
   * A cap is not a safety net bolted on afterwards — it is a termination
   * guarantee for model calls. It bounds steps only: one reply can still carry an
   * unbounded list of tool calls, which is why the per-step, per-run and deadline
   * budgets below exist alongside it rather than instead of it.
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
   * Wall-clock ceiling for one `send`, in milliseconds.
   *
   * Without it the loop is bounded only by the number of calls, and a slow
   * provider turns a bounded number of calls into unbounded waiting.
   */
  deadlineMs?: number;
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
  temperature?: number;
}

export const DEFAULT_MAX_TOOL_CALLS_PER_STEP = 8;
export const DEFAULT_MAX_TOOL_CALLS_PER_RUN = 32;
export const DEFAULT_DEADLINE_MS = 300_000;
export const DEFAULT_MAX_CONTEXT_BYTES = 512 * 1024;
export const DEFAULT_MAX_CONTEXT_TOKENS = 131_072;

export const DEFAULT_MAX_STEPS = 10;

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

  constructor(bytes: number, limit: number) {
    super(
      `context budget exceeded: prompt is ${bytes} bytes, limit is ${limit} ` +
        `(a byte ceiling, not a token count — start a new session or shorten the history)`,
    );
    this.name = "ContextBudgetError";
    this.bytes = bytes;
    this.limit = limit;
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
  return `[步骤 ${budget.stepsUsed}/${budget.maxSteps} · 工具 ${budget.toolCallsUsed}/${budget.maxToolCallsPerRun}` +
    ` · prompt ${size(budget.promptBytes)}/${size(budget.maxContextBytes)} · ${tokens}` +
    // Printed only when a provider reported it. The whole point of this number is
    // that a two-word answer can still burn a thousand output tokens; hiding it is
    // what made the spend look inexplicable.
    (budget.reasoningTokens === undefined ? "" : ` · 推理 ${budget.reasoningTokens}`) +
    ` · 用时 ${time(budget.elapsedMs)}/${time(budget.deadlineMs)}]`;
}

export interface SendResult {
  reply: ChatMessage;
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
  private readonly temperature: number | undefined;
  private prepared: Promise<void> | undefined;
  private busy = false;
  private readonly onActivity: ((event: RuntimeActivity) => void) | undefined;
  private activity(event: RuntimeActivity): void { try { this.onActivity?.(event); } catch { /* display must not corrupt execution */ } }

  constructor(options: AgentRuntimeOptions) {
    this.adapter = options.adapter;
    this.onActivity = options.onActivity;
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
    this.toolEnvironment = buildToolEnvironment({
      workspaceRoot: this.workspaceRoot, agentHome: this.home,
      protectedRoots: this.configuredProtectedRoots,
    });
    this.tools = options.tools;
    this.maxSteps = positiveInt("maxSteps", options.maxSteps, DEFAULT_MAX_STEPS);
    this.maxToolCallsPerStep = positiveInt("maxToolCallsPerStep", options.maxToolCallsPerStep, DEFAULT_MAX_TOOL_CALLS_PER_STEP);
    this.maxToolCallsPerRun = positiveInt("maxToolCallsPerRun", options.maxToolCallsPerRun, DEFAULT_MAX_TOOL_CALLS_PER_RUN);
    this.deadlineMs = positiveInt("deadlineMs", options.deadlineMs, DEFAULT_DEADLINE_MS);
    this.maxContextBytes = positiveInt("maxContextBytes", options.maxContextBytes, DEFAULT_MAX_CONTEXT_BYTES);
    this.maxContextTokens = positiveInt("maxContextTokens", options.maxContextTokens, DEFAULT_MAX_CONTEXT_TOKENS);
    this.contextWindows = validateContextWindows(options.contextWindows);
    this.countPromptTokens = options.countPromptTokens;
    this.model = options.model;
    this.systemPrompt = options.systemPrompt;
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
    const deadline = AbortSignal.timeout(this.deadlineMs);
    const composed = signal ? AbortSignal.any([signal, deadline]) : deadline;
    try { return await this.store.withWriter(this.sessionId, async () => {
      composed.throwIfAborted();
      await this.store.assertReady(this.sessionId);
      return this.sendTurn(input, composed);
    }); }
    catch (error) {
      // Only our own deadline may be relabelled: a caller's Ctrl+C stays a
      // cancellation, and a genuine failure is never dressed up as a timeout.
      if (deadline.aborted && !(signal?.aborted ?? false) && isAbortError(error)) {
        throw new DeadlineExceededError(this.deadlineMs);
      }
      throw error;
    }
    finally { this.busy = false; }
  }

  private async sendTurn(input: string, signal?: AbortSignal): Promise<SendResult> {
    const text = input.trim();
    if (text.length === 0) throw new Error("empty input");

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

    const usage: ChatUsage = { inputTokens: 0, outputTokens: 0 };
    let reasoningTokens: number | undefined;
    let reasoning: string | undefined;
    const startedAt = Date.now();
    let model = this.adapter.defaultModel;
    let steps = 0;
    let toolCalls = 0;

    while (true) {
      if (steps >= this.maxSteps) throw new StepLimitError(steps);

      signal?.throwIfAborted();
      const messages = await this.buildPrompt();
      // Checked every step as well: the prompt grows with each tool result, so a
      // prompt that fit at step one is no guarantee at step five.
      this.assertContextFits(messages);
      signal?.throwIfAborted();
      this.activity({ type: "model" });
      const response = await this.adapter.chat(
        {
          messages,
          ...(this.tools ? { tools: this.tools.definitions() } : {}),
          ...(this.model ? { model: this.model } : {}),
          ...(this.temperature === undefined ? {} : { temperature: this.temperature }),
        },
        signal,
      );
      signal?.throwIfAborted();
      validateResponse(response);
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
        return {
          reply: assistant,
          usage,
          model,
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
          },
        };
      }

      toolCalls += await this.runToolCalls(response.toolCalls, signal, runId, steps);
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
  ): Promise<number> {
    const context: ToolContext = {
      workspaceRoot: this.workspaceRoot,
      toolEnvironment: this.toolEnvironment,
      protectedRoots: this.protectedRoots,
      ...(signal ? { signal } : {}),
    };
    for (const call of calls) {
      // Complete pending tool correlations even after cancellation, but never start another executor.
      let result;
      if (signal?.aborted) result = { content: "cancelled: tool was not executed", isError: true };
      else {
        this.activity({ type: "tool-start", name: call.name });
        result = signal?.aborted ? { content: "cancelled: tool was not executed", isError: true }
          : this.tools ? await this.tools.execute(call, context)
          : { content: `no tools are configured, cannot run ${call.name}`, isError: true };
        this.activity({ type: "tool-end", name: call.name, isError: result.isError === true });
      }
      // One line, not three (ADR-0001): the assistant turn above already recorded
      // what was requested, so this message is the whole record of what came back.
      await this.store.appendMessage(
        this.sessionId,
        { role: "tool", content: result.content, toolCallId: call.id },
        { runId, step, isError: result.isError === true },
      );
    }
    signal?.throwIfAborted();
    return calls.length;
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
    const past = await this.store.history(this.sessionId);
    const system: ChatMessage[] = this.systemPrompt ? [{ role: "system", content: this.systemPrompt }] : [];
    const compaction = await this.store.compaction(this.sessionId);
    if (compaction && compaction.covers > 0) {
      const covered = Math.min(compaction.covers, past.length);
      const summary: ChatMessage = {
        role: "system",
        content: `Earlier tool results were omitted after message ${covered}. ` +
          `User and assistant messages below stay verbatim. The full transcript is still in the session log.\n\n${compaction.summary}`,
      };
      const visible = past.map((message, index) =>
        index < covered && message.role === "tool"
          ? { ...message, content: `[tool result omitted; ${message.content.length} chars remain in the session log]` }
          : message);
      return extra ? [...system, summary, ...visible, extra] : [...system, summary, ...visible];
    }
    return extra ? [...system, ...past, extra] : [...system, ...past];
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
