/**
 * Per-cycle write budget (D18).
 *
 * A gene's `constraints` were a record, not a rule: `maxFiles` and `maxLines`
 * were written down and nothing enforced them. A constraint that is only
 * recorded is a suggestion, and this module is what turns it into a rule.
 *
 * The ledger is pure arithmetic over what a round has already written. Counting
 * is deliberately conservative: files are counted exactly (distinct paths), and
 * lines are counted only where the tool arguments make them mechanically
 * readable. Where they are not — delete, rename, a patch — the file is counted
 * and the lines are not estimated, because an invented number would make the
 * budget meaningless in exactly the case where it matters.
 */

export interface WriteBudget {
  /** Distinct files this cycle may touch. */
  readonly maxFiles: number;
  /** Lines added plus changed across this cycle. */
  readonly maxLines: number;
  /**
   * Workspace-relative paths this cycle may not write, added by D103.
   *
   * The header of this module already states the principle: "A gene's
   * `constraints` were a record, not a rule: `maxFiles` and `maxLines` were
   * written down and nothing enforced them. A constraint that is only recorded is
   * a suggestion." D18 turned two of the three members into rules and left the
   * third a suggestion — `forbiddenPaths` was declared in `types.ts`, parsed in
   * `gene.ts`, and written by both `distill.ts` and `induct.ts`, but this
   * function's own signature was `{ maxFiles: number; maxLines: number } | null`,
   * so it never reached an enforcement path. Nothing in `src/` refused a write on
   * account of it.
   *
   * Declared-but-unenforced is worse than absent, which is why this came before
   * the budget-derivation work: an absent limit is a debt anybody can see, while a
   * recorded one reads as a guarantee to everyone who never checks.
   */
  readonly forbiddenPaths: readonly string[];
}

/** Tools that change the workspace. Reads are not writes. */
const WRITE_TOOL_LINE_ARGUMENT: Readonly<Record<string, string | null>> = {
  edit_file: "content",
  create_file: "content",
  // These change a file without carrying new content in the arguments.
  patch_file: null,
  delete_file: null,
  rename_file: null,
  batch_files: null,
  // Null like `run_command` and `job_kill`: it writes no file, so there is no
  // content whose lines could be counted, and charging lines would misreport the
  // budget's meaning (lines of code written). It still consumes an anonymous file
  // slot through `checkWrite`'s null-path branch, which is the honest charge —
  // one write happened this round, and it changed what the model is told next.
  update_task_state: null,
};

export function isWriteTool(tool: string): boolean {
  return Object.hasOwn(WRITE_TOOL_LINE_ARGUMENT, tool);
}

export interface WriteAttempt {
  readonly tool: string;
  /** Workspace-relative path the write targets, when the arguments name one. */
  readonly path: string | null;
  /** Lines the arguments actually carry, or null when they carry none. */
  readonly lines: number | null;
}

/**
 * Read a write attempt out of a tool call. Returns null when the call is not a
 * write. Unparseable arguments are treated as a write with unknown extent: the
 * file is still counted, so malformed arguments cannot buy extra budget.
 */
export function readWriteAttempt(tool: string, argumentsJson: string): WriteAttempt | null {
  if (!isWriteTool(tool)) return null;
  const lineArgument = WRITE_TOOL_LINE_ARGUMENT[tool];
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return { tool, path: null, lines: null };
  }
  if (typeof parsed !== "object" || parsed === null) return { tool, path: null, lines: null };
  const record = parsed as Record<string, unknown>;
  const path = typeof record.path === "string" && record.path !== "" ? record.path
    : typeof record.to === "string" && record.to !== "" ? record.to
    : null;
  if (lineArgument === null || lineArgument === undefined) return { tool, path, lines: null };
  const content = record[lineArgument];
  // No readable path means the write cannot be attributed, and no readable
  // content means its extent is unknown. Either way the extent is unknown, so
  // report null rather than a number that would make an unreadable write look
  // cheaper than a readable one.
  if (path === null || typeof content !== "string") return { tool, path, lines: null };
  // A trailing newline ends the last line rather than starting an empty one.
  const lines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  return { tool, path, lines };
}

export interface LedgerState {
  readonly files: readonly string[];
  readonly lines: number;
}

export interface LedgerDecision {
  readonly allowed: boolean;
  /** Present when the attempt was refused; the operator-facing reason. */
  readonly reason?: string;
}

export class WriteBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteBudgetError";
  }
}

/**
 * Compare paths the way the filesystem under this product does: separators are
 * interchangeable and case is not significant. Comparison only — the ledger keeps
 * recording the path exactly as the tool arguments gave it, because that string is
 * what an operator reads back in an audit line.
 */
function normalizeForComparison(raw: string): string {
  return raw.replace(/\\/g, "/").replace(/^\.?\//, "").replace(/\/+$/, "").toLowerCase();
}

/**
 * The forbidden entry that covers this path, or null. Matching is by path SEGMENT
 * rather than by string prefix, so a gene forbidding `docs` refuses `docs/a.md`
 * but not `docs2/a.md` — the second is a different directory that merely starts
 * with the same letters, and refusing it would make the rule mean something other
 * than what was written down.
 */
function forbiddenEntryFor(target: string, forbiddenPaths: readonly string[]): string | null {
  const path = normalizeForComparison(target);
  for (const entry of forbiddenPaths) {
    const root = normalizeForComparison(entry);
    // An empty entry forbids nothing. Silently treating "" as "everything" would
    // turn a malformed gene into a total write ban, and a ban nobody asked for is
    // as wrong as a gap nobody closed.
    if (root === "") continue;
    if (path === root || path.startsWith(`${root}/`)) return entry;
  }
  return null;
}

/**
 * Decide whether one more write fits, without performing it. Refusing here means
 * the write never happens, so a refusal cannot leave a half-written file behind.
 */
export function checkWrite(
  state: LedgerState,
  attempt: WriteAttempt,
  budget: WriteBudget,
): LedgerDecision {
  // Forbidden paths are checked first, before either counter, because they are a
  // different kind of limit: a budget says "this much and no more", so spending it
  // down is normal and running out is an accounting fact. A forbidden path says
  // "not here at all", so remaining budget is irrelevant to it.
  if (budget.forbiddenPaths.length > 0) {
    if (attempt.path === null) {
      // Fail closed, and the precedent is this module's own: unparseable arguments
      // are already treated as a write of unknown extent so that "malformed
      // arguments cannot buy extra budget". The same reasoning applies here — a
      // target that cannot be read cannot be shown to lie outside the forbidden
      // set, and guessing would let the ban be evaded by malforming the call.
      return refusal(`cycle forbids writing under ${budget.forbiddenPaths.join(", ")}; this write's target could not be read from its arguments, so it cannot be shown to lie outside them`);
    }
    const entry = forbiddenEntryFor(attempt.path, budget.forbiddenPaths);
    if (entry !== null) {
      return refusal(`cycle forbids this path: ${attempt.path} is under ${entry}`);
    }
  }
  if (attempt.path === null) {
    // A write whose target cannot be read from the arguments still consumes
    // budget: it is charged as its own anonymous slot rather than waved through.
    const anonymous = state.files.filter((entry) => entry.startsWith("\u0000")).length;
    if (anonymous + 1 > budget.maxFiles) {
      return refusal(`cycle file budget exhausted (${budget.maxFiles}); a write with no readable path was refused`);
    }
  } else if (!state.files.includes(attempt.path) && state.files.length + 1 > budget.maxFiles) {
    return refusal(`cycle file budget exhausted: ${budget.maxFiles} file(s) per cycle, ${attempt.path} would be number ${state.files.length + 1}`);
  }
  const lines = attempt.lines ?? 0;
  if (state.lines + lines > budget.maxLines) {
    return refusal(`cycle line budget exhausted: ${budget.maxLines} line(s) per cycle, this write adds ${lines} to ${state.lines}`);
  }
  return { allowed: true };
}

function refusal(reason: string): LedgerDecision {
  return { allowed: false, reason };
}

/**
 * The budget a round needs after the ceiling refused one of its writes, or null
 * when raising cannot help and the refusal should stand.
 *
 * This is the outlet D127's separation was missing. D127 established that "this
 * round was given too little room" is a different lesson from "this strategy did
 * not work" — and then left the first lesson with nowhere to go: the refusal was
 * counted, kept off the success axis, and the round carried on with the same
 * too-small ceiling for the rest of its life. The ceiling was a measurement
 * that could never be corrected by the thing it measured.
 *
 * A refusal is checked *before* the tool runs (`checkWrite`), so the write did
 * not happen and re-running it under more room costs nothing and cannot leave a
 * half-written file behind.
 *
 * Null means "do not raise". Two cases produce it: an attempt refused by
 * `forbiddenPaths`, which is policy rather than measurement and cannot be
 * widened by arithmetic; and an attempt that already fits, which would be a
 * refusal this function cannot explain.
 *
 * The "at most one raise per round" bound lives in the caller, not here: a
 * ceiling that always yields is not a ceiling, and the design leans on the wall
 * being real enough to be hit again next round.
 */
export function raiseFor(
  state: LedgerState,
  attempt: WriteAttempt,
  budget: WriteBudget,
): WriteBudget | null {
  // Policy first. A banned path stays banned however much room is added, so
  // spending the round's one raise on it would waste the raise and still refuse.
  if (budget.forbiddenPaths.length > 0) {
    if (attempt.path === null) return null;
    if (forbiddenEntryFor(attempt.path, budget.forbiddenPaths) !== null) return null;
  }
  const anonymous = state.files.filter((entry) => entry.startsWith("\u0000")).length;
  const filesNeeded = attempt.path === null
    ? anonymous + 1
    : state.files.includes(attempt.path) ? state.files.length : state.files.length + 1;
  const linesNeeded = state.lines + (attempt.lines ?? 0);
  const maxFiles = Math.max(budget.maxFiles, filesNeeded);
  const maxLines = Math.max(budget.maxLines, linesNeeded);
  if (maxFiles === budget.maxFiles && maxLines === budget.maxLines) return null;
  return { maxFiles, maxLines, forbiddenPaths: budget.forbiddenPaths };
}

/** Charge an attempt that was actually performed. */
export function chargeWrite(state: LedgerState, attempt: WriteAttempt, index: number): LedgerState {
  const path = attempt.path ?? `\u0000${index}`;
  const files = state.files.includes(path) ? state.files : [...state.files, path];
  return { files, lines: state.lines + (attempt.lines ?? 0) };
}

/**
 * The budget a round runs under: the applied gene's constraints widened against
 * the default, or the default alone when no gene applies.
 *
 * ⚠️ The two budget axes only ever **widen**. `distill.ts` and `induct.ts` size a
 * new gene with `measuredBudget`, whose cold start is `COLD_START_BUDGET` =
 * `{1, 20}` — a guess, and the tightest number in this file. Enforced as a
 * ceiling it cuts a normal multi-file round to one file; that round then fails on
 * `WriteBudgetError` with `steps > 0`, so `cycle.ts` charges the failure to the
 * gene rather than calling it a blocked start, and the library records "this
 * strategy failed" for what was really "nobody measured this". That is D127's
 * defect one level up: there the guess was a constant in the minter, here it is
 * the minter's cold-start return value. `measuredBudget` already says as much of
 * its own fallback ("a floor, never a ceiling"); this applies it a layer up.
 *
 * `forbiddenPaths` is **not** floored: a ban is policy, not a measurement, and
 * widening it would silently lift a restriction.
 *
 * The parameter type names all three members of `GeneConstraints` rather than
 * accepting the interface itself, so a caller holding something else cannot pass
 * it by accident — and so that the omission D103 fixed is visible here: this
 * signature used to list two of the three, which is how a declared constraint
 * stayed unenforced while every producer kept writing it.
 */
export function budgetFor(
  constraints: { maxFiles: number; maxLines: number; forbiddenPaths?: readonly string[] } | null,
  fallback: WriteBudget,
): WriteBudget {
  if (constraints === null) return fallback;
  return {
    maxFiles: Math.max(constraints.maxFiles, fallback.maxFiles),
    maxLines: Math.max(constraints.maxLines, fallback.maxLines),
    forbiddenPaths: constraints.forbiddenPaths ?? [],
  };
}

/** One round's write footprint, as journaled. */
export interface WriteObservation {
  readonly filesWritten: number;
  readonly linesWritten: number;
  /** Refusals of this round's writes by the budget — see `measuredBudget`. */
  readonly budgetRefusals: number;
  /**
   * The ceiling this round actually ran under, when the row recorded one.
   *
   * Carried on the observation rather than passed to `measuredBudget` as an
   * argument because both callers (`distill.ts`, `induct.ts`) are pure over
   * facts and hold no library, so neither can resolve a gene address to that
   * gene's constraints. Optional: rows written before this was journaled
   * contribute no ceiling sample, which reads the same as a cold start.
   */
  readonly ceilingFiles?: number;
  readonly ceilingLines?: number;
}

/** The guess used before any round has been measured. */
export const COLD_START_BUDGET = { maxFiles: 1, maxLines: 20 } as const;

/**
 * The floor under a measured budget, and deliberately not `COLD_START_BUDGET`.
 *
 * It exists to stop one thing: a group whose rounds all wrote nothing minting a
 * gene with a 0-file budget, which would refuse the first write of the next
 * round. Pinning the bottom to the cold-start guess instead would mean a gene
 * could never be narrower than a number nobody measured — and narrowing is the
 * whole point of taking the median below.
 */
export const MIN_MEASURED_BUDGET = { maxFiles: 1, maxLines: 1 } as const;

/** Quantile of an already-sorted array. Nearest-rank; no interpolation. */
function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const rank = Math.ceil(q * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1]!;
}

/**
 * The estimator `measuredBudget` uses. 0.5, not 0.95 — see property 2 of its doc
 * block: a quantile near the maximum is dragged up by its tail and has no way
 * back down, which is exactly the one-way ratchet this replaced.
 */
const MEDIAN = 0.5;

/**
 * The distinct ceilings the observations ran under, once each.
 *
 * Once per *value*, never once per observation: repeating the ceiling for every
 * round under it would put the old ceiling in the majority and leave the median
 * sitting on it, which is the fixed point `measuredBudget` exists to escape. A
 * row journaled before the ceiling was recorded contributes nothing here.
 */
function ceilings(
  observations: readonly WriteObservation[],
  pick: (observation: WriteObservation) => number | undefined,
): number[] {
  const seen = new Set<number>();
  for (const observation of observations) {
    const value = pick(observation);
    if (value !== undefined) seen.add(value);
  }
  return [...seen];
}

/**
 * Size a budget from what rounds of this kind actually needed (D127, revised).
 *
 * The number this replaces was a constant. Every guard `distill.ts` minted
 * carried `{maxFiles: 1, maxLines: 20}`, which nobody derived from anything, and
 * a round that exceeded it lost its success — so the library learned "this
 * strategy failed" from what was really "this strategy was given too little
 * room". A budget is a measurement, so it should be taken rather than guessed.
 *
 * ⚠️ Three properties carry the design.
 *
 * **1. Censoring must be undone.** A round the budget stopped records what it
 * *reached*, never what it *needed* — the observation is a lower bound, and its
 * value is literally the cap. Reading it as demand would re-derive the same
 * too-small budget on every pass, so the cap would never lift: a fixed point
 * that measures nothing. A refusal therefore adds back the room that was missing
 * (`reached + 1`). It is still only a lower bound — one file was refused, so at
 * least one more was wanted — and that is the honest direction to be wrong in.
 * A write the ceiling refused and then *raised itself to allow* (`raiseFor`) is
 * not censored at all: it landed, so `filesWritten` is the true demand.
 *
 * **2. The median, and the ceiling in force is one of the samples.** p95 had the
 * defect this whole line of work is about: a quantile near the maximum is
 * dragged up by its tail and never comes back down, so the estimate could only
 * ratchet upward. A gene that needed 5, then 8, then 10 could never be tightened
 * back toward 5, and "must use 10" read as progress instead of as regression.
 * The median over the demands *plus the ceiling the rounds ran under* fixes both
 * halves. The ceiling sample is what makes the number fall when demand falls: a
 * group that ran under 7 and then needed 4, 4, 3 lands on 4, not 7. The median
 * is what stops one outsized round from defining the budget.
 *
 * The ceiling enters **once per group**, as the distinct value the observations
 * were bounded by — never once per observation. Three rounds refused at a
 * ceiling of 6 contribute a demand of 7 each *and* the single 6 they ran under,
 * so the samples are `{6, 7, 7, 7}` and the median is 7. Sampling the ceiling
 * per observation would give `{6, 6, 6, 7, 7, 7}`, whose median is 6 — the same
 * fixed point, one indirection later.
 *
 * **3. The floor stops a zero, and only a zero.** See `MIN_MEASURED_BUDGET`.
 * Cold start (no observations at all) still returns the fallback untouched,
 * which is the normal case for a request kind nothing has been measured for.
 */
export function measuredBudget(
  observations: readonly WriteObservation[],
  fallback: { maxFiles: number; maxLines: number } = COLD_START_BUDGET,
): { maxFiles: number; maxLines: number } {
  // ⚠️ A row that recorded no footprint at all is **not** a measurement of zero.
  // It is a row written before the footprint was journaled, and `gene-store.ts`
  // promises exactly that reading ("the estimator treats it as a cold start
  // rather than as a zero"). The reader maps the absent fields with `?? 0`, so
  // the promise can only be kept here. Without this, a group nobody ever measured
  // mints a 1-line gene — the constant-guess defect again, one layer down, and
  // hidden until the median replaced the floor that used to rescue it.
  const measured = observations.filter((o) =>
    o.filesWritten !== 0 || o.linesWritten !== 0 || o.budgetRefusals !== 0
    || o.ceilingFiles !== undefined || o.ceilingLines !== undefined);
  if (measured.length === 0) return { ...fallback };
  // Uncensored value: `reached + 1` whenever this round was refused at least
  // once, because a refusal proves at least one more unit was wanted.
  const demand = (reached: number, refusals: number): number => (refusals > 0 ? reached + 1 : reached);
  const files = [...measured.map((o) => demand(o.filesWritten, o.budgetRefusals)), ...ceilings(measured, (o) => o.ceilingFiles)].sort((a, b) => a - b);
  const lines = [...measured.map((o) => demand(o.linesWritten, o.budgetRefusals)), ...ceilings(measured, (o) => o.ceilingLines)].sort((a, b) => a - b);
  return {
    maxFiles: Math.max(MIN_MEASURED_BUDGET.maxFiles, quantile(files, MEDIAN)),
    maxLines: Math.max(MIN_MEASURED_BUDGET.maxLines, quantile(lines, MEDIAN)),
  };
}
