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
  }
  /**
   * A gene taken out of selection (D105). Append-only like everything else here:
   * retiring writes a record rather than removing one, so the library can still
   * say what it once knew and why it stopped using it.
   *
   * Retirement is not deletion and not quarantine. Quarantine (`quarantineStreak`)
   * is automatic and recoverable — one new success lifts it. Retirement is a
   * decision, it persists, and the gene stays in the library: its address must
   * keep resolving, because outcome rows already written against it are that
   * gene's track record and `state()` folds them whether or not it is selectable.
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
  /** Live genes with their folded expression counters. */
  readonly genes: ReadonlyMap<string, { gene: Gene; expression: GeneExpression }>;
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

  constructor(path: string, options: { rng?: () => number } = {}) {
    this.path = path;
    this.rng = options.rng ?? Math.random;
  }

  /** Parse the log once; later appends update the in-memory fold. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.records = []; return; }
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
    this.records = parsed;
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
   * The failure archive: every journaled failure that names the request kind it
   * came from. Rows without `intent`/`signals` predate the archive (or are
   * successes) and cannot form a pattern, so they are not returned.
   */
  async failures(): Promise<FailureFact[]> {
    const records = await this.ensureLoaded();
    const facts: FailureFact[] = [];
    for (const record of records) {
      if (record.type !== "outcome" || record.succeeded) continue;
      if (!record.intent || !record.signals || !record.failureClass) continue;
      facts.push({
        at: record.at,
        intent: record.intent,
        signals: record.signals,
        failureClass: record.failureClass,
        evidence: record.evidence ?? [],
        address: record.address,
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
      if (record.address !== null) continue;
      if (!record.intent || !record.signals) continue;
      facts.push({
        at: record.at,
        intent: record.intent,
        signals: record.signals,
        tools: record.tools ?? [],
        evidence: record.evidence ?? [],
      });
    }
    return facts;
  }

  private async append(record: GeneStoreRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    this.records?.push(record);
  }

  /** Current state: the fold over the whole log. */
  async state(): Promise<GeneLibraryState> {
    const records = await this.ensureLoaded();
    const genes = new Map<string, { gene: Gene; expression: GeneExpression }>();
    const retired = new Map<string, string>();
    const baseline = { attempts: 0, successes: 0 };
    for (const record of records) {
      if (record.type === "gene") {
        if (!genes.has(record.address)) genes.set(record.address, { gene: record.gene, expression: { attempts: 0, successes: 0, lastSuccessAt: null, streak: 0 } });
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
      if (record.address === null) {
        baseline.attempts += 1;
        if (record.succeeded) baseline.successes += 1;
        continue;
      }
      const entry = genes.get(record.address);
      if (!entry) continue;
      entry.expression.attempts += 1;
      if (record.succeeded) {
        entry.expression.successes += 1;
        entry.expression.lastSuccessAt = record.at;
        entry.expression.streak = 0;
      }
      else entry.expression.streak += 1;
    }
    return { genes, baseline, retired };
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
    return { address: selection.address, name: selection.gene.name, constraints: selection.gene.constraints, validation: selection.gene.validation, block: renderGeneBlock(selection), drifted };
  }
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
