/**
 * Append-only persistence for the gene library (D14).
 *
 * The store is a log, not a database of current values (mechanism adopted
 * from dsh-swarm core/store.ts): every mutation appends a record and the
 * current state is a fold over the log. Content-addressed gene records make
 * re-appending the same gene idempotent, and a truncated final line is
 * tolerated (a crash during append) while a malformed middle line is refused
 * (damage that would silently change what the library contains).
 *
 * Outcome rows with `address: null` are the gene-less baseline — the
 * counterfactual that future gain pricing needs, recorded from day one.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  DEFAULT_SELECTION_POLICY,
  computeDriftIntensity,
  driftIndex,
  selectGene,
  type Gene,
  type GeneExpression,
  type GeneIntent,
  type GeneRequest,
  type MintedGene,
  type ScoredCandidate,
} from "./gene.ts";
import type { EvaluationStatus, FailureClass } from "./cycle.ts";
import type { FailureFact } from "./distill.ts";
import type { SuccessFact } from "./induct.ts";
import { measuredBudget, type BlastTier, type WriteObservation } from "./write-budget.ts";

const SCHEMA = 1;

export type GeneStoreRecord =
  | { readonly schema: 1; readonly type: "gene"; readonly at: number; readonly address: string; readonly gene: Gene }
  | {
    readonly schema: 1;
    readonly type: "outcome";
    readonly at: number;
    readonly address: string | null;
    readonly succeeded: boolean;
    /** The cycle verdict this row came from. Absent on rows written before D15. */
    readonly status?: EvaluationStatus;
    readonly failureClass?: FailureClass | null;
    /** The request kind, so repeated failures can be grouped (D16). */
    readonly intent?: GeneIntent;
    readonly signals?: readonly string[];
    /** Mechanical counts the verdict was read off. Never raw error text. */
    readonly evidence?: readonly string[];
    /**
     * Tools this round actually called, in order. What the transcript proves —
     * not what a strategy should be (D17).
     */
    readonly tools?: readonly string[];
    /**
     * What the round's write ledger actually reached (D127).
     *
     * These three exist so a gene's `constraints` can be *measured* instead of
     * guessed: `distill.ts` used to mint every guard with a hardcoded
     * `{maxFiles: 1, maxLines: 20}`, a number nobody derived from anything.
     *
     * ⚠️ `filesWritten`/`linesWritten` are a **lower bound on demand**, not
     * demand itself. A round stopped by the budget records what it managed, not
     * what it needed — so `budgetRefusals` is what tells a reader whether the
     * number is censored, and the estimator must add back the room that was
     * missing. Reading the capped value as demand would re-derive the same
     * too-small budget forever.
     *
     * Optional, like `drifted`: rows written before this field keep their exact
     * bytes and read as "no measurement", which the estimator treats as a
     * cold start rather than as a zero.
     */
    readonly filesWritten?: number;
    readonly linesWritten?: number;
    readonly budgetRefusals?: number;
    /**
     * The ceiling the round ran under, so the estimator can weigh the limit
     * beside the demand it produced (D127, second revision).
     *
     * The median over demands alone can only ever sit where the demands are: it
     * can rise but has nothing pulling it back down. The ceiling is what lets the
     * number fall again when demand falls, and what stops one round from moving
     * it. Journaled once per round, read once per group — repeating it per
     * observation would put the old ceiling in the majority and reproduce the
     * fixed point being removed.
     *
     * Optional for the same reason as the three above: rows written before this
     * field keep their exact bytes and read as "the ceiling is unknown", which
     * contributes no ceiling sample rather than a zero.
     */
    readonly writeCeiling?: { readonly files: number };
    /**
     * How far past its declared number this round went (D151), and what that cost
     * it (D152).
     *
     * `blastTier` is the label the operator reads; `outcomeWeight` is the only
     * thing the fold uses, and it is absent when it is 1. Written only when the
     * round went past its number at all, so a round inside its number keeps the
     * exact bytes it always had and "did not overrun" stays distinguishable from
     * "the field did not exist yet".
     *
     * ⚠️ `outcomeWeight` replaced a binary rule that zeroed a truncated round's
     * success outright. The two together double-charged one overrun; the graded
     * weight is what the operator asked for, so the binary rule now covers only
     * refusals the ladder did not cause.
     */
    readonly blastTier?: BlastTier;
    readonly outcomeWeight?: number;
    /**
     * Whether drift, not the score, chose the gene this outcome belongs to (D108).
     *
     * Optional, and it stays optional rather than becoming required: every outcome
     * row already written predates drift, and an append-only log cannot be
     * back-filled without rewriting it — which would destroy exactly the property
     * that makes crash recovery here a truncated-tail check instead of a repair
     * procedure. A missing field therefore reads as "chosen by score", which was
     * true of every round before this one.
     *
     * ⚠️ It is folded into the outcome row rather than written as a separate record
     * because a second row per round would roughly double log growth (measured at
     * 232–560 B per outcome row), and unbounded growth is the question that started
     * this whole line of work.
     */
    readonly drifted?: boolean;
    /**
     * Whether this round can say anything at all about the gene it ran under.
     *
     * Written **only when false**, for the same append-only reason as `drifted`:
     * rows already on disk predate the field and read as graded, which is what
     * they were. `false` marks a round that ended in success while calling **no
     * tool** — a chat answer, not work. The row is still written (the log is the
     * record of what happened, and dropping it would hide traffic) but it moves
     * neither `attempts` nor `successes`, because a reply that touched nothing
     * cannot testify about the strategy it ran under. Crediting it teaches the
     * library "this strategy produces agreeable replies" instead of "this
     * strategy gets work done". Measured on this workspace's own rounds: 20 of
     * the 24 credited successes called no tool.
     *
     * ⚠️ The predicate is deliberately **narrow** — success, no tool, no failure.
     * A refusal or a pre-cycle failure keeps its verdict and stays charged, so
     * this cannot become a way for a bad strategy to stop being blamed. What is
     * dropped is only the case that carried no evidence either way.
     */
    readonly graded?: boolean;
    /**
     * Addresses of every gene that competed this round, the winner included (D113).
     *
     * Optional and only written when a gene was applied, for the same append-only
     * reason as `drifted`: old rows predate it and are not back-filled, so absence
     * means "not recorded", not "no competition". Folded into this row rather than
     * written as a separate record — a second row per round would roughly double log
     * growth (232–560 B/row), which is the size concern that started this work.
     */
    readonly candidates?: readonly string[];
  }
  /**
   * A gene taken out of selection (D105). Append-only like everything else here:
   * retiring writes a record rather than removing one, so the library can still
   * say what it once knew and why it stopped using it.
   *
   * Retirement is not deletion and not quarantine. Quarantine (`quarantineStreak`)
   * is automatic and **recoverable** — one new success lifts it, and it is
   * recomputed on every selection rather than recorded anywhere. Retirement is
   * written once, it persists, and the gene stays in the library: its address must
   * keep resolving, because outcome rows already written against it are that
   * gene's track record and `state()` folds them whether or not it is selectable.
   *
   * ⚠️ A retirement can now be **automatic** as well as human — see
   * `retirementDue`. The reason is still mandatory and still recorded; what
   * changed is that the reason may now be a counted fact instead of an operator's
   * opinion. That is better attribution, not less: a machine that retires a gene
   * for a stated mechanical reason is more auditable than one that only ever
   * retires it because somebody said so.
   *
   * There is deliberately no `unretire`. A gene's address is its content hash, so
   * "bring it back" is already expressible without a new record type: mint the
   * same content again and `appendGene`'s idempotence makes it one gene, while a
   * corrected strategy hashes to a different address and is simply a new gene.
   * Adding an unretire would create a second way to answer the same question, and
   * two answers to one question is how a library stops being auditable.
   */
  | { readonly schema: 1; readonly type: "retire"; readonly at: number; readonly address: string; readonly reason: string };

export interface GeneLibraryState {
  /**
   * Live genes with their folded expression counters and the write budget their
   * own rounds imply — which is **not** `gene.constraints`, the prior they were
   * minted from. See `reMeasure` for why the two are allowed to differ, and why
   * the difference is derived here instead of written into a successor gene.
   */
  readonly genes: ReadonlyMap<string, { gene: Gene; expression: GeneExpression; constraints: Gene["constraints"] }>;
  /** Gene-less baseline outcomes, the counterfactual for future gain pricing. */
  readonly baseline: { attempts: number; successes: number };
  /**
   * Retired address → the reason given, folded from `retire` records. Kept in the
   * state rather than filtered out of `genes` so that "what does the library know"
   * and "what may the library use" stay two separate questions: the first is
   * audit, the second is selection. A gene retired twice keeps the later reason,
   * because that is the one that explains its current status.
   */
  readonly retired: ReadonlyMap<string, string>;
}

export interface AppliedGene {
  readonly address: string;
  readonly name: string;
  /** The block injected into this send's system prompt (test-time evolution). */
  readonly block: string;
  /**
   * The gene's own write limits, carried for the enforcement layer rather than
   * the prompt: a constraint that is only written into a prompt is a suggestion,
   * so these bound the round mechanically (D18).
   */
  readonly constraints: Gene["constraints"];
  /**
   * The gene's claims, carried so the runtime can compare them against what the
   * round actually did (D20). Like `constraints`, this is enforcement data: the
   * prompt says what to prove, this decides whether it was proven.
   */
  readonly validation: Gene["validation"];
  /**
   * Whether drift, not the score, chose this gene (D108).
   *
   * Carried rather than inferred, and it must reach the outcome row: a round whose
   * gene was picked at random from the top-N is not the same evidence as one whose
   * gene won on score, and a log that cannot tell them apart would credit or blame
   * the gene for a choice the selector made. That is precisely the silence D107
   * removed for tie-breaks, and wiring drift without this field would rebuild it one
   * stage later.
   */
  readonly drifted: boolean;
  /**
   * The addresses of every gene that competed this round — all candidates that
   * passed the hard gates and were scored, the winner included (D113).
   *
   * This is the losing-candidate record the counterfactual replay needs and has
   * been owed for many rounds. Without it the ledger records who won and whether it
   * worked, but not who it beat, so no later run can ask "would a different metric
   * or weight have chosen better here" — the question every weight decision now
   * defers to for lack of exactly this data.
   *
   * ⚠️ Addresses only, not scores. A score is a float computed under the current
   * weights, so recording it would freeze one policy's numbers into the log and make
   * a replay under different weights compare against stale values; the addresses let
   * a replay re-fold each candidate's record to the moment of the choice and
   * recompute. Addresses are also the whole of what a replay needs: the winner is
   * already the outcome row's `address`, so the losers are this set minus that.
   */
  readonly candidates: readonly string[];
}

export class GeneStore {
  private records: GeneStoreRecord[] | null = null;
  private readonly path: string;
  /**
   * The entropy source for drift selection (D108). Injectable so a test can pin it,
   * because `driftIndex` promises `rng()` is called at most twice and a test that
   * cannot predict the draws cannot tell which branch it exercised.
   *
   * ⚠️ It defaults to `Math.random` rather than to "no drift". The alternative —
   * drift off unless a caller opts in — is how a mechanism ends up shipped and dead,
   * which is the defect class this project has now hit three times
   * (`forbiddenPaths`, `retire`, and the overrun signal with no consumer). Tests that
   * need determinism inject a seeded rng; that is the correct fix, and it is the same
   * shape EvoMap documents for its own `driftSelect`.
   */
  private readonly rng: () => number;
  /**
   * Where outcome rows go, split off from gene/retire rows (D116, growth-plan
   * step 2). Derived from `path`, not a second constructor argument, so all 33 call
   * sites keep passing one path and the split is a storage detail they do not see.
   *
   * ⚠️ Why split: outcome rows are the high-frequency stream (one per round, now
   * carrying `candidates`), while gene/retire rows change only when the library's
   * shape does. Keeping them apart lets the outcome stream be compacted or
   * checkpointed later without touching the gene definitions — the growth concern
   * that started this. A mixed legacy file is still read whole, so this is
   * forward-only: old outcome lines in `path` still fold.
   */
  private readonly outcomesPath: string;

  constructor(path: string, options: { rng?: () => number } = {}) {
    this.path = path;
    this.outcomesPath = path.replace(/\.jsonl$/, "") + ".outcomes.jsonl";
    this.rng = options.rng ?? Math.random;
  }

  /** Parse both logs once; later appends update the in-memory fold. */
  async load(): Promise<void> {
    // Gene/retire rows come from `path`, outcome rows from the companion file. A
    // legacy mixed file has outcome rows in `path` too, and those still parse and
    // fold — the split only changes where NEW rows are written.
    const main = await this.parseLog(this.path);
    const outcomes = await this.parseLog(this.outcomesPath);
    // ⚠️ Concatenation order is safe because `state()` does not depend on the
    // relative order of gene vs outcome rows: a gene builds its map entry, an
    // outcome folds into an entry that already exists (`if (!entry) continue`). Only
    // outcomes' order relative to EACH OTHER matters (streak, lastSuccessAt), and
    // those keep their append order within the companion file.
    this.records = [...main, ...outcomes];
  }

  private async parseLog(file: string): Promise<GeneStoreRecord[]> {
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const lines = text.split("\n");
    // The writer always ends with "\n", so dropping the final split element
    // removes the trailing empty artifact on a healthy log — and removes the
    // partial line a crash left behind when the file ends mid-record.
    if (lines.length > 0) lines.pop();
    const parsed: GeneStoreRecord[] = [];
    for (let index = 0; index < lines.length; index++) {
      try {
        const record = JSON.parse(lines[index] ?? "") as GeneStoreRecord;
        if (record.schema !== SCHEMA || (record.type !== "gene" && record.type !== "outcome" && record.type !== "retire")) {
          throw new Error(`unsupported record`);
        }
        parsed.push(record);
      } catch (error) {
        throw new Error(`gene store line ${index + 1} is not a valid v${SCHEMA} record: ${(error as Error).message}`);
      }
    }
    return parsed;
  }

  private async ensureLoaded(): Promise<GeneStoreRecord[]> {
    if (this.records === null) await this.load();
    return this.records!;
  }

  /** Idempotent by address: the same gene appended twice is one gene. */
  async appendGene(minted: MintedGene, at: number = Date.now()): Promise<void> {
    const records = await this.ensureLoaded();
    if (records.some((record) => record.type === "gene" && record.address === minted.address)) return;
    await this.append({ schema: SCHEMA, type: "gene", at, address: minted.address, gene: minted.gene });
  }

  async appendOutcome(
    outcome: {
      address: string | null;
      succeeded: boolean;
      status?: EvaluationStatus;
      failureClass?: FailureClass | null;
      intent?: GeneIntent;
      signals?: readonly string[];
      evidence?: readonly string[];
      tools?: readonly string[];
      drifted?: boolean;
      candidates?: readonly string[];
      filesWritten?: number;
      linesWritten?: number;
      budgetRefusals?: number;
      writeCeiling?: { files: number };
      /**
       * How far past its declared number this round went (D151). Written only when
       * it went past at all. Nothing in the fold reads it — the verdict already
       * carries the cost — so it is here for the operator reading the log, which is
       * the same reason `evidence` is here.
       */
      blastTier?: BlastTier;
      /**
       * What this round contributes to the success count it lands in (D152):
       * 1 normally, 0.7 for an overrun, 0.4 for one that reached the hard stop.
       * Absent means 1, so an ordinary round keeps the exact bytes it always had.
       */
      outcomeWeight?: number;
      graded?: boolean;
    },
    at: number = Date.now(),
  ): Promise<void> {
    await this.append({ schema: SCHEMA, type: "outcome", at, ...outcome });
  }

  /**
   * Take a gene out of selection. Append-only, like every other mutation here.
   *
   * Both arguments are checked, and for the same reason: a retirement that
   * silently did nothing would be indistinguishable from one that worked, and a
   * retirement with no reason recorded is an attribution decision made by nobody.
   * The non-empty-reason rule is the reference implementation's own
   * (`dsh-swarm core/store.ts` refuses an empty thumbs reason the same way).
   */
  async retire(address: string, reason: string, at: number = Date.now()): Promise<void> {
    if (reason.trim() === "") throw new Error("retire reason must be a non-empty string");
    const records = await this.ensureLoaded();
    if (!records.some((record) => record.type === "gene" && record.address === address)) {
      throw new Error(`cannot retire a gene that is not in the library: ${address}`);
    }
    await this.append({ schema: SCHEMA, type: "retire", at, address, reason });
  }

  /**
   * The lesson archive: every journaled round that names the request kind it came
   * from **and** has something to teach about why it did not manage what it was
   * asked for. That is two shapes, not one:
   *
   * - a round that **failed**, which carries its own `failureClass`; and
   * - a round that **succeeded but was stopped by its ceiling** — a standing
   *   `budgetRefusals > 0`. It has no `failureClass` of its own, because it ended
   *   in success, so it takes `"budget"`: the same class `classifyFailure` gives a
   *   budget error, and the one that names what actually happened.
   *
   * The second shape is why this method matters. `measuredBudget` can only be fed
   * by this method and by `geneLessSuccesses()`, and a truncated success reached
   * **neither**: this one required `succeeded === false`, that one required
   * `address === null`. So the strongest single piece of evidence that a gene is
   * mis-sized — a round that ran into the number that gene declared — was
   * excluded from the estimator that sizes genes, while the gene kept a record of
   * clean successes. 甲 floored the consumer against exactly that, which is why it
   * could not be removed before this.
   *
   * The name is now narrower than the meaning, and stays: renaming it would churn
   * every caller for a word.
   *
   * Rows without `intent`/`signals` predate the archive and cannot form a pattern;
   * an ungraded row carries no evidence either way. Neither is returned.
   */
  async failures(): Promise<FailureFact[]> {
    const records = await this.ensureLoaded();
    const facts: FailureFact[] = [];
    for (const record of records) {
      if (record.type !== "outcome") continue;
      const truncated = (record.budgetRefusals ?? 0) > 0;
      // A success is a lesson only when its ceiling stopped something.
      if (record.succeeded && !truncated) continue;
      // An ungraded round carries no evidence about the strategy, so it must not
      // reach distillation either: a chat answer is not a failure pattern.
      if (record.graded === false) continue;
      if (!record.intent || !record.signals) continue;
      const failureClass = record.failureClass ?? (truncated ? "budget" : null);
      if (!failureClass) continue;
      facts.push({
        at: record.at,
        intent: record.intent,
        signals: record.signals,
        failureClass,
        evidence: record.evidence ?? [],
        address: record.address,
        filesWritten: record.filesWritten ?? 0,
        linesWritten: record.linesWritten ?? 0,
        budgetRefusals: record.budgetRefusals ?? 0,
        ceilingFiles: record.writeCeiling?.files,
      });
    }
    return facts;
  }

  /**
   * Successful rounds that applied no gene: the gap induction exists for. A
   * round that used a gene is not a gap, and a row without the request kind
   * cannot be grouped.
   */
  async geneLessSuccesses(): Promise<SuccessFact[]> {
    const records = await this.ensureLoaded();
    const facts: SuccessFact[] = [];
    for (const record of records) {
      if (record.type !== "outcome" || !record.succeeded) continue;
      // Induction mints from successes that used no gene. An ungraded success would
      // become a gene for "answer questions agreeably" — the same mistake as
      // crediting it, one step further downstream.
      if (record.graded === false) continue;
      if (record.address !== null) continue;
      if (!record.intent || !record.signals) continue;
      facts.push({
        at: record.at,
        intent: record.intent,
        signals: record.signals,
        tools: record.tools ?? [],
        evidence: record.evidence ?? [],
        filesWritten: record.filesWritten ?? 0,
        linesWritten: record.linesWritten ?? 0,
        budgetRefusals: record.budgetRefusals ?? 0,
        ceilingFiles: record.writeCeiling?.files,
      });
    }
    return facts;
  }

  private async append(record: GeneStoreRecord): Promise<void> {
    // Outcome rows go to the companion file, gene/retire rows to the main one. The
    // in-memory fold pushes onto one array either way, because a fresh append is
    // always chronologically last and `state()`'s cross-type independence (see
    // `load`) means its position among genes does not matter.
    const file = record.type === "outcome" ? this.outcomesPath : this.path;
    await mkdir(dirname(file), { recursive: true });
    await appendFile(file, `${JSON.stringify(record)}\n`, "utf8");
    this.records?.push(record);
  }

  /** Current state: the fold over the whole log. */
  async state(): Promise<GeneLibraryState> {
    const records = await this.ensureLoaded();
    // Two passes, and the split is the point: the first walk is the log read in
    // order (streak and lastSuccessAt depend on that order), the second turns each
    // gene's own rounds into the budget it now implies. See `reMeasure`.
    const folded = new Map<string, { gene: Gene; expression: GeneExpression; rounds: WriteObservation[] }>();
    const retired = new Map<string, string>();
    const baseline = { attempts: 0, successes: 0 };
    for (const record of records) {
      if (record.type === "gene") {
        if (!folded.has(record.address)) folded.set(record.address, { gene: record.gene, expression: { attempts: 0, successes: 0, lastSuccessAt: null, streak: 0, contradicted: 0 }, rounds: [] });
        continue;
      }
      // Before the outcome branch, and the order is load-bearing rather than
      // stylistic: a retire record carries an `address`, so falling through would
      // charge the gene it retires with one more attempt. Retirement would then
      // edit the track record it was only meant to stop consulting — the same
      // class of bug as a mutation that changes the number it is supposed to
      // merely read.
      if (record.type === "retire") {
        retired.set(record.address, record.reason);
        continue;
      }
      // After the retire branch and before both credit branches, so an ungraded
      // round leaves no trace at all: no attempt, no success, no streak, and no
      // baseline count. Symmetric on purpose — charging an attempt while refusing
      // the success would be strictly worse than either counting or ignoring it,
      // because it manufactures a failure out of a round that produced no evidence.
      // ⚠️ `budgetRefusals` splits the success branch in two, and it is the only
      // thing that does. A round that ran into the number its *own gene* declared
      // did not get what it was asked for, so crediting it as a clean success would
      // let a gene that truncates every round keep a spotless record — which is the
      // shape 甲 floored the consumer against. The attempt still counts, because the
      // gene was applied and did run; `streak` is deliberately left alone, because
      // quarantine is for strategy failures and deleting a capability over the
      // minter's arithmetic is the mistake D127 undid, one layer over.
      //
      // The baseline below is left whole on purpose, and the asymmetry has a
      // reason. A gene-less round has no declared number that could be wrong, so
      // its truncation measures the runtime default — and deflating the control
      // group's success rate would flatter every gene's relative score.
      // The baseline is still left whole, and for the reason D127 gave: a gene-less
      // round has no declared number that could be wrong — its ceiling is the
      // runtime default, a guess — so charging it for exceeding a guess would
      // deflate the control group and flatter every gene against it. The weight is
      // recorded on these rows all the same; it is the *fold* that declines to use
      // it here, and that is a decision, not an omission.
      if (record.graded === false) continue;
      const truncated = (record.budgetRefusals ?? 0) > 0;
      if (record.address === null) {
        baseline.attempts += 1;
        if (record.succeeded) baseline.successes += 1;
        continue;
      }
      const entry = folded.get(record.address);
      if (!entry) continue;
      entry.expression.attempts += 1;
      // ⚠️ The one counter here that is attributable to the *gene* rather than to
      // the round. `failureClass === "validation"` is written only where the verdict
      // was downgraded because a claim **the gene itself declared** was shown false —
      // not because a tool errored, the model misbehaved, or the task was hard. That
      // is why `retirementDue` may act on this counter and not on `streak`, which
      // counts verdicts and therefore counts the whole world along with the strategy.
      if (record.failureClass === "validation") entry.expression.contradicted += 1;
      // The gene's own footprint, kept as raw material for `reMeasure`. Rows from
      // before the footprint and the ceiling were journaled carry nothing here, and
      // the estimator filters those rather than reading them as zeros — the
      // cold-start promise `WriteObservation` documents.
      entry.rounds.push({
        filesWritten: record.filesWritten ?? 0,
        linesWritten: record.linesWritten ?? 0,
        budgetRefusals: record.budgetRefusals ?? 0,
        ceilingFiles: record.writeCeiling?.files,
      });
      // ⚠️ D152: `truncated` no longer zeroes the success on its own. The ladder
      // grades how much room a round cost, and keeping the binary rule beside the
      // graded one charged the same overrun twice. What the rule still covers is a
      // refusal the ladder did NOT cause: a round whose tier is `within` and which
      // was nonetheless refused was writing under a forbidden path — its own gene
      // said not to, and no weight expresses that.
      //
      // The weight is what the round contributes instead of 1. A gene that is
      // stopped at the hard stop every time therefore settles at 0.4 rather than a
      // spotless record, which is the property this branch existed to protect.
      const weight = record.outcomeWeight ?? 1;
      const ladderStopped = record.blastTier !== undefined;
      if (record.succeeded && (ladderStopped || !truncated)) {
        entry.expression.successes += weight;
        entry.expression.lastSuccessAt = record.at;
        entry.expression.streak = 0;
      }
      else if (!record.succeeded) entry.expression.streak += 1;
    }
    return { genes: reMeasure(folded), baseline, retired };
  }

  /**
   * Select a gene for one request and render its injection block. Returns
   * undefined when no live candidate matches — an honest gene-less round.
   *
   * Retired genes are dropped here rather than in `state()`, so the fold still
   * reports the whole library. That is the point of keeping the two apart: an
   * operator asking "what has this agent learned" gets every gene including the
   * retired ones with their reasons, while a round asking "what should I apply"
   * never sees them. It also stops the cost the question that prompted this
   * change was about — a gene that stopped being selected used to be parsed,
   * folded and scored on every single round forever, and now it is folded but not
   * scored.
   */
  async selectFor(request: GeneRequest, now: number = Date.now()): Promise<AppliedGene | undefined> {
    const state = await this.state();
    const candidates = [...state.genes.entries()]
      .filter(([address]) => !state.retired.has(address))
      .map(([address, entry]) => ({ address, gene: entry.gene, expression: entry.expression }));
    const { ranked } = selectGene(candidates, request, DEFAULT_SELECTION_POLICY, now);
    if (ranked.length === 0) return undefined;
    // Drift runs after scoring and picks an index into the ranked list, so
    // `selectGene` itself stays deterministic — the same library still gives the
    // same ranking, and only the choice from it can vary (D107).
    //
    // Intensity is computed from the live pool, not the whole library: a retired
    // gene is not a candidate, so counting it would understate how often the
    // remaining ones get tried. Maturity is total attempts across that pool, so an
    // old but idle library has not earned the low-intensity floor.
    const totalAttempts = candidates.reduce((sum, candidate) => sum + candidate.expression.attempts, 0);
    const intensity = computeDriftIntensity(ranked.length, totalAttempts);
    const { index, drifted } = driftIndex(ranked.length, intensity, this.rng);
    const selection = ranked[index] ?? ranked[0]!;
    // Every scored candidate competed, so all of `ranked` is the competition, not
    // just the runner-up. Excluded genes are already gone (selectGene drops them at
    // the gates), so this is exactly "who was eligible and lost", which is what a
    // replay contrasts the winner against.
    const candidateAddresses = ranked.map((candidate) => candidate.address);
    // The folded budget, not the declared one. A gene's number is re-measured from
    // its own rounds on every fold, so the declaration is the prior it starts from
    // rather than the number an old gene runs under forever. See `reMeasure`.
    const constraints = state.genes.get(selection.address)?.constraints ?? selection.gene.constraints;
    return { address: selection.address, name: selection.gene.name, constraints, validation: selection.gene.validation, block: renderGeneBlock(selection), drifted, candidates: candidateAddresses };
  }
}

/**
 * Every gene's write budget, re-measured from its own rounds.
 *
 * ⚠️ **Why this is derived rather than stored, and why no successor is minted.**
 * A gene is content-addressed and immutable, and the documented way to change one
 * is to mint a successor and retire the predecessor. That is right for a corrected
 * *strategy* and wrong for a corrected *number*: a successor is a different
 * address, so every attempt and success accumulated against the old one stays
 * there while the old one is retired — a working capability's whole track record
 * discarded to fix an arithmetic. So the declared `constraints` keep exactly the
 * bytes they were minted with (they are part of the hash) and the number that
 * reaches the enforcement layer is folded out of the log instead. Deterministic,
 * replayable, and nothing has to be migrated.
 *
 * The declared pair is the **prior**, not a floor. With no rounds yet it comes
 * back untouched; once the gene has rounds, the median over those rounds plus the
 * ceilings they ran under takes over. That is what lets a gene be tightened as
 * well as widened — "原来5就够，为什么现在要10" is the question, and p95 could
 * never answer it because a tail quantile has nothing pulling it down. It is also
 * what eventually lets 甲's floor go: a cold-start `{1, 20}` gene used to be
 * frozen at the number a minter guessed, and a gene that truncates every round now
 * has its own truncated rounds in the sample set correcting it.
 *
 * ⚠️ `forbiddenPaths` is carried through from the declaration and **never**
 * re-measured. A ban is policy rather than measurement, and widening it would
 * silently lift a restriction — 甲's rule, unchanged here.
 */
function reMeasure(
  folded: ReadonlyMap<string, { gene: Gene; expression: GeneExpression; rounds: readonly WriteObservation[] }>,
): Map<string, { gene: Gene; expression: GeneExpression; constraints: Gene["constraints"] }> {
  const genes = new Map<string, { gene: Gene; expression: GeneExpression; constraints: Gene["constraints"] }>();
  for (const [address, entry] of folded) {
    const measured = measuredBudget(entry.rounds, entry.gene.constraints);
    genes.set(address, {
      gene: entry.gene,
      expression: entry.expression,
      constraints: { ...measured, forbiddenPaths: entry.gene.constraints.forbiddenPaths },
    });
  }
  return genes;
}

/** Test-time injection: the strategy and warnings, never the constraints. */
function renderGeneBlock(candidate: ScoredCandidate): string {
  const gene = candidate.gene;
  const lines: string[] = [`<applied_gene name="${gene.name}" address="${candidate.address}">`];
  if (gene.preconditions.length > 0) lines.push(`Preconditions:`, ...gene.preconditions.map((item) => `- ${item}`));
  lines.push(`Proven strategy, follow in order:`, ...gene.strategy.map((step) => `- [${step.kind}] ${step.text}`));
  if (gene.validation.length > 0) lines.push(`Prove it worked:`, ...gene.validation.map((item) => `- ${item}`));
  if (gene.avoid.length > 0) lines.push(`Avoid, distilled from past failures:`, ...gene.avoid.map((item) => `- ${item}`));
  lines.push(`</applied_gene>`);
  return lines.join("\n");
}

/**
 * Contradicted rounds after which the library retires a gene on its own.
 *
 * ⚠️ Two, and it is not a new number: `DEFAULT_SELECTION_POLICY.quarantineStreak`
 * is already 2, and the reference implementation's ban layer is also "two
 * independent failures". A third threshold for the same question would be a
 * third answer to one question, which is how a library stops being auditable.
 */
export const AUTO_RETIRE_CONTRADICTIONS = 2;

/**
 * Whether the library should retire this gene by itself, and the reason to write
 * into the retirement record if so. `null` means "no".
 *
 * The rule is **two against and nothing for**, and each half is there for a
 * different reason:
 *
 * - `contradicted >= 2` may *cause* a retirement, because it is the only signal
 *   in this store that is attributable to the gene. The gene said what proof
 *   looks like; the round ran exactly that and it failed. The task, the model and
 *   the context are all still in that number, but the gene chose the test.
 * - `successes === 0` may only *veto* one. A verdict is produced by everything at
 *   once, so it is far too weak to retire a gene on — but it is more than strong
 *   enough to hold the rule back, and holding back is the conservative direction.
 *   **A weak signal is safe as a guard and unsafe as a cause**, which is why the
 *   two halves are not symmetric.
 *
 * ⚠️ The asymmetry also makes the rule immune to the starvation trap recorded in
 * D106. A gene that has never been selected has no rounds, so it cannot be
 * retired here — "never had a chance" and "was given chances and failed" stay
 * distinguishable, which is exactly what "retire after N non-selections" got
 * wrong and why it was rejected.
 *
 * ⚠️ The counts are read from the folded record, not from a live tally, so the
 * rule is a pure function of the log and replays identically.
 */
export function retirementDue(entry: { readonly expression: GeneExpression }): string | null {
  const { contradicted, successes } = entry.expression;
  if (contradicted < AUTO_RETIRE_CONTRADICTIONS) return null;
  if (successes > 0) return null;
  return `自动退休：自己声明的验证被反驳 ${contradicted} 轮、且从未成功过（阈值 ${AUTO_RETIRE_CONTRADICTIONS} 轮）`;
}
