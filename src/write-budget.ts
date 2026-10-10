/**
 * Per-cycle write budget (D18).
 *
 * A gene's `constraints` were a record, not a rule: the numbers in them were
 * written down and nothing enforced them. A constraint that is only recorded is
 * a suggestion, and this module is what turns it into a rule.
 *
 * ⚠️ **The budget has one axis: files.** It used to have two, and the second one
 * was the binding one in practice. Measured over this repo's own last twelve
 * commits, lines-per-file runs 20–80, so a single 400-line document — one file,
 * comfortably inside any file budget — was refused by the line counter, while a
 * four-file fifty-line change was refused by the file counter. The two limits
 * governed two different shapes of work, and the one that governed "write a
 * document" was the one nobody meant to constrain.
 *
 * The reference implementation (EvoMap/Evolver) has **no line budget at all**:
 * its gene constraints carry `max_files` and `forbidden_paths` and nothing else,
 * and lines are compared only against one global ceiling. This module now has
 * the same shape — one per-round axis, and one global line ceiling
 * (`GLOBAL_LINE_CAP`) whose only job is to stop a runaway write.
 *
 * Lines are still **counted and journaled**: what a round actually wrote is
 * evidence, and the evidence is what `measuredBudget` runs on. What is gone is
 * lines as a thing a round may be refused for.
 *
 * Counting is deliberately conservative: files are counted exactly (distinct
 * paths), and lines are counted only where the tool arguments make them
 * mechanically readable. Where they are not — delete, rename, a patch — the file
 * is counted and the lines are not estimated, because an invented number would
 * make the budget meaningless in exactly the case where it matters.
 */

export interface WriteBudget {
  /** Distinct files this cycle may touch. */
  readonly maxFiles: number;
  /**
   * Workspace-relative paths this cycle may not write, added by D103.
   *
   * The header of this module already states the principle: "A gene's
   * `constraints` were a record, not a rule ... A constraint that is only
   * recorded is a suggestion." D18 turned the counted members into rules and left
   * the third a suggestion — `forbiddenPaths` was declared in `types.ts`, parsed
   * in `gene.ts`, and written by both `distill.ts` and `induct.ts`, but this
   * function's own signature listed only the counters, so it never reached an
   * enforcement path. Nothing in `src/` refused a write on account of it.
   *
   * Declared-but-unenforced is worse than absent, which is why this came before
   * the budget-derivation work: an absent limit is a debt anybody can see, while a
   * recorded one reads as a guarantee to everyone who never checks.
   */
  readonly forbiddenPaths: readonly string[];
}

/**
 * The only line ceiling left, and it is global rather than per round.
 *
 * It does not measure a round's ambition; it stops one. Every real round this
 * repo has recorded is orders of magnitude below it, so it cannot refuse
 * ordinary work — which is the point. The value is the largest line count that
 * still reads as a deliberate backstop rather than as a budget, and it exists so
 * that removing the per-round counter did not leave the axis unguarded.
 */
export const GLOBAL_LINE_CAP = 65_535;

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
 * The agent's own journal, and the paths exempt from the budget count.
 *
 * ⚠️ Two lists, deliberately of different length, because they answer two
 * different questions.
 *
 * The **journal** answers "did this round do any work?". Writing your own diary
 * is never the work, whatever the round was asked to do — the journal is written
 * on every round, so its presence is not evidence that anything happened. It is
 * a directory rather than a set of extensions on purpose: an extension whitelist
 * cannot express "this round's deliverable is the document", so it would call a
 * documentation round hollow. That false positive is not hypothetical — the
 * reference implementation shipped it and had to patch it.
 *
 * The **budget** list answers "should this write spend the round's room?". It is
 * the journal plus test artifacts, because a test artifact is not chosen by the
 * agent at all: the round was told to run the tests and the runner wrote them.
 * Charging for that would let a single test run exhaust a round's budget.
 *
 * Documentation is on the counting side of both lists. A document write is real
 * blast radius, and a round whose deliverable is the document is real work.
 */
const JOURNAL_PREFIXES: readonly string[] = [".personal-agent"];

/** Journal plus test artifacts: exempt from the count, still not work. */
const BUDGET_EXEMPT_PREFIXES: readonly string[] = [".personal-agent", ".test-artifacts"];

/** Path-segment match, the same rule `forbiddenEntryFor` uses. */
function underAnyPrefix(raw: string | null, prefixes: readonly string[]): boolean {
  // A write whose target could not be read is never exempt. This module's
  // precedent already says unparseable arguments must not buy extra room, and
  // the same argument holds here: a target that cannot be read cannot be shown
  // to be the agent's own diary.
  if (raw === null) return false;
  const path = normalizeForComparison(raw);
  if (path === "") return false;
  return prefixes.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

/** Does this write spend the round's file and line budget? */
export function countsTowardWriteBudget(path: string | null): boolean {
  return !underAnyPrefix(path, BUDGET_EXEMPT_PREFIXES);
}

/** Is this path inside the agent's own journal? */
export function isJournalPath(path: string): boolean {
  return underAnyPrefix(path, JOURNAL_PREFIXES);
}

/**
 * The ratios that turn a declared file count into a ladder.
 *
 * ⚠️ These replace a hard wall at `maxFiles + 1`. The operator's reasoning, and
 * why the wall had to go: a round that needs 28 files against a declared 20 is
 * doing real work, and refusing it means the work does not get done at all — the
 * estimate's error costs the objective. The reference implementation has no wall
 * at the declared number either; it labels the overrun and starts charging only
 * further out.
 *
 * The numbers are the operator's, not the reference's (which uses 2x and 3x), and
 * they are deliberately tighter: the reference's declared numbers are much larger
 * and its penalty is a multiplier on a continuous score. Ours: past 1.3x the round
 * stops counting as a clean success, and at 1.5x the ladder stops.
 */
export const OVERRUN_RATIO = 1.3;
export const HARD_STOP_RATIO = 1.5;

/**
 * The least absolute headroom the stop must leave, whatever the ratio says.
 *
 * ⚠️ Without this the ladder collapses exactly where the declared numbers are
 * smallest, which is where it matters most. A ratio alone has no whole unit to
 * stand on down there: 1.3x and 1.5x of 1 are 1.3 and 1.5, so both bands between
 * the thresholds are empty and the ladder degenerates into "one file, then stop"
 * — the wall it replaced, wearing a new name. Two files of headroom guarantee at
 * least one rung at every declared value.
 *
 * What it costs: at declared values below 4 the stop is no longer exactly 1.5x.
 * That is the trade, stated rather than hidden — and it is why `hard_stop` is a
 * tier that large declared values can never reach: 1.5N - 1 is always under 1.5N,
 * so a round declaring 20 tops out at 29 files and 1.45x. The 0.4 weight below is
 * therefore a small-number tier, which is coherent: the floor gives those rounds
 * absolute room and charges them more, relatively, for using it.
 */
export const ABSOLUTE_HEADROOM = 2;

/**
 * What an overrunning round contributes to the record it lands in.
 *
 * The operator's own numbers, and deliberately not zero. Zero would say "this
 * strategy did not work" about a strategy that did work — it simply spent more
 * room than it declared — and the hard stop has already cost the round its
 * completeness, so zero would charge the same overrun twice. The progression
 * 1.0 / 0.7 / 0.4 is monotone for the same reason: a cliff at the end tells a
 * reader "never do this", which is not what an oversized round means.
 */
export const OVERRUN_WEIGHT = 0.7;
export const HARD_STOP_WEIGHT = 0.4;

/** How far a round's blast radius got, relative to the number it declared. */
export type BlastTier = "within" | "exceeded" | "overrun" | "hard_stop";

/**
 * Classify what a round reached against what it declared.
 *
 * Pure, and computed from the ledger the budget already counts, so the ladder
 * needs no state of its own. Boundaries are inclusive at the top of each tier:
 * with a declared 20, 25 is `exceeded`, 26 is the first `overrun`, and 30 is the
 * first refused write. Stated as a table because an off-by-one comparison here
 * silently restores the wall the ladder exists to remove.
 */
export function blastTier(filesReached: number, maxFiles: number): BlastTier {
  if (maxFiles <= 0) return "within";
  const ratio = filesReached / maxFiles;
  if (ratio >= HARD_STOP_RATIO) return "hard_stop";
  if (ratio >= OVERRUN_RATIO) return "overrun";
  return ratio > 1 ? "exceeded" : "within";
}

/** The file count at which the ladder stops: 1.5x the declared number, floored. */
export function hardStopAt(maxFiles: number): number {
  return Math.max(maxFiles * HARD_STOP_RATIO, maxFiles + ABSOLUTE_HEADROOM);
}

/**
 * What this round's tier costs it in the folded record.
 *
 * Kept here beside the tiers rather than in the fold, so the ladder is the one
 * place that says what an overrun is worth. `within` and `exceeded` are both 1:
 * an overrun the operator chose to label but not charge for stays free, which is
 * the reference implementation's own split.
 */
export function blastWeight(tier: BlastTier): number {
  if (tier === "overrun") return OVERRUN_WEIGHT;
  if (tier === "hard_stop") return HARD_STOP_WEIGHT;
  return 1;
}

/**
 * Decide whether one more write fits, without performing it. Refusing here means
 * the write never happens, so a refusal cannot leave a half-written file behind.
 *
 * ⚠️ This no longer refuses at the declared number. It refuses only at the hard
 * stop (1.5x); everything between the declared number and that stop is allowed
 * and *labelled* — `blastTier` is what turns "the round went over" into a cost,
 * and it is applied to the finished round, not to the write in front of it.
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
  // Exempt writes pass without touching either counter. Checked *after* the ban,
  // never before: a ban is policy, and an exempt path is still a path this cycle
  // may have forbidden — skipping the ban for the agent's own journal would turn
  // a restriction into a hole shaped exactly like the file the agent writes most.
  if (!countsTowardWriteBudget(attempt.path)) return { allowed: true };
  // The only file-count refusal left, and it sits at the hard stop rather than at
  // the declared number. Reaching the stop is refused *inclusive*: with a declared
  // 20 the stop is 30, so 29 writes land and the thirtieth does not.
  const stop = hardStopAt(budget.maxFiles);
  if (attempt.path === null) {
    // A write whose target cannot be read from the arguments still consumes
    // budget: it is charged as its own anonymous slot rather than waved through.
    const anonymous = state.files.filter((entry) => entry.startsWith("\u0000")).length;
    if (anonymous + 1 >= stop) {
      return refusal(`cycle blast radius hard stop: ${Math.ceil(stop)} file(s) is the limit for a declared ${budget.maxFiles} (1.5x, never less than +${ABSOLUTE_HEADROOM}); a write with no readable path was refused`);
    }
  } else if (!state.files.includes(attempt.path) && state.files.length + 1 >= stop) {
    return refusal(`cycle blast radius hard stop: ${Math.ceil(stop)} file(s) is the limit for a declared ${budget.maxFiles} (1.5x, never less than +${ABSOLUTE_HEADROOM}), ${attempt.path} would be number ${state.files.length + 1}`);
  }
  const lines = attempt.lines ?? 0;
  // The only line check left, and it is global. A round's own line budget is gone
  // (see the header): lines governed "one big document", which is ordinary work,
  // and the per-round counter refused it while the file counter never would have.
  // What remains stops a runaway write and cannot refuse real work.
  if (state.lines + lines > GLOBAL_LINE_CAP) {
    return refusal(`global line ceiling reached: ${GLOBAL_LINE_CAP} line(s) in one cycle, this write adds ${lines} to ${state.lines}`);
  }
  return { allowed: true };
}

function refusal(reason: string): LedgerDecision {
  return { allowed: false, reason };
}

/**
 * Charge an attempt that was actually performed.
 */
export function chargeWrite(state: LedgerState, attempt: WriteAttempt, index: number): LedgerState {
  // The ledger is what the budget is measured against, so it must record exactly
  // what the budget counts. An exempt write that still landed here would spend
  // room that `checkWrite` never charged for.
  if (!countsTowardWriteBudget(attempt.path)) return state;
  const path = attempt.path ?? `\u0000${index}`;
  const files = state.files.includes(path) ? state.files : [...state.files, path];
  return { files, lines: state.lines + (attempt.lines ?? 0) };
}

/**
 * The budget a round runs under: the applied gene's constraints, or the default
 * alone when no gene applies.
 *
 * ⚠️ **A gene's numbers stand as declared — the default is a default, not a
 * floor.** This function used to widen them with `Math.max(declared, fallback)`
 * (甲). Its reasoning was sound about the *cold start* and wrong about the
 * *contract*: `COLD_START_BUDGET` = `{1}` is a guess, and enforcing a guess
 * as a ceiling cuts a normal multi-file round to one file, after which the round
 * is charged to the gene for a number nobody measured.
 *
 * The cure for that is to make the number a **measurement** — which is what
 * `measuredBudget` (D127) does for new genes and what the fold does for genes
 * already in the library (戊) — **not** to put a second number underneath it. A
 * floor and a default are one operator apart in code and opposite in meaning: a
 * default answers "what bounds a round that was told nothing?", while a declared
 * constraint answers "what bounds a round that was told something?". Enforcing
 * both means the declared number can only ever move **up** — the one-way ratchet
 * 丙 removed from the estimator and 甲 left standing at the point of use.
 *
 * The floor also had nothing to inherit it from. The reference implementation
 * (EvoMap/Evolver) treats its `max_files: 20` as a **default applied only when
 * the field is absent** — `createGene` normalizes it in that one case — and
 * ships 17 seed genes declaring 1 through 50, **twelve of them below 20**, the
 * smallest at 1. A floor that raised those would contradict the genes its own
 * author wrote.
 *
 * `MIN_MEASURED_BUDGET` (1) is a different thing and stays: it blocks **zero**,
 * not smallness, and it lives in the estimator where a group's median is taken.
 * `forbiddenPaths` is not floored and never was — a ban is policy, not a
 * measurement, and widening it would silently lift a restriction.
 *
 * The parameter type names the members of `GeneConstraints` rather than accepting
 * the interface itself, so a caller holding something else cannot pass it by
 * accident — and so that the omission D103 fixed is visible here: this signature
 * used to list fewer members than the interface had, which is how a declared
 * constraint stayed unenforced while every producer kept writing it.
 */
export function budgetFor(
  constraints: { maxFiles: number; forbiddenPaths?: readonly string[] } | null,
  fallback: WriteBudget,
): WriteBudget {
  if (constraints === null) return fallback;
  return {
    maxFiles: constraints.maxFiles,
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
}

/**
 * The guess used before any round has been measured.
 *
 * One file, because files are the only axis a budget has. It fires only for a
 * group whose rounds recorded no write at all — a group that did write gets its
 * median instead, and the fold re-measures an existing gene from its own rounds.
 * `measuredBudget`'s doc says why an all-zero group reads as a cold start rather
 * than as a measurement of zero.
 */
export const COLD_START_BUDGET = { maxFiles: 1 } as const;

/**
 * The floor under a measured budget, and deliberately not `COLD_START_BUDGET`.
 *
 * It exists to stop one thing: a group whose rounds all wrote nothing minting a
 * gene with a 0-file budget, which would refuse the first write of the next
 * round. Pinning the bottom to the cold-start guess instead would mean a gene
 * could never be narrower than a number nobody measured — and narrowing is the
 * whole point of taking the median below.
 */
export const MIN_MEASURED_BUDGET = { maxFiles: 1 } as const;

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
  fallback: { maxFiles: number } = COLD_START_BUDGET,
): { maxFiles: number } {
  // ⚠️ A row that recorded no footprint at all is **not** a measurement of zero.
  // It is a row written before the footprint was journaled, and `gene-store.ts`
  // promises exactly that reading ("the estimator treats it as a cold start
  // rather than as a zero"). The reader maps the absent fields with `?? 0`, so
  // the promise can only be kept here. Without this, a group nobody ever measured
  // mints a 1-file gene — the constant-guess defect again, one layer down, and
  // hidden until the median replaced the floor that used to rescue it.
  //
  // The filter is stated on the axis that exists. `linesWritten` is still
  // journaled as blast radius but is no longer a budget axis, so it cannot make a
  // row "measured" — a row with no file count has nothing this estimator can size.
  const measured = observations.filter((o) =>
    o.filesWritten !== 0 || o.budgetRefusals !== 0 || o.ceilingFiles !== undefined);
  if (measured.length === 0) return { ...fallback };
  // Uncensored value: `reached + 1` whenever this round was refused at least
  // once, because a refusal proves at least one more unit was wanted.
  const demand = (reached: number, refusals: number): number => (refusals > 0 ? reached + 1 : reached);
  const files = [...measured.map((o) => demand(o.filesWritten, o.budgetRefusals)), ...ceilings(measured, (o) => o.ceilingFiles)].sort((a, b) => a - b);
  return { maxFiles: Math.max(MIN_MEASURED_BUDGET.maxFiles, quantile(files, MEDIAN)) };
}
