/**
 * Genes: compact, immutable capability units, and the selection math (D14).
 *
 * A Gene is what a validated round taught: which signals say it applies, the
 * ordered strategy that worked, the limits it may not exceed, and the commands
 * that prove it. Its identity is the content address of its own fields, so a
 * Gene is never edited — only superseded by a new Gene with a new address.
 *
 * Evidence chain: dsh-swarm core/gene.ts + core/selection.ts (mechanism),
 * EvoMap/evolver seed library + arXiv:2604.15097 (Gene beats static Skill by
 * +8.7~15.5pp and halves tokens, BUT a gene distilled without a real success
 * trajectory is worse than a Skill — which is why minting stays an
 * operator-owned decision over validated experience, never automatic).
 */
import { createHash } from "node:crypto";

import type { TaskIntent } from "./taskspec.ts";
import type {
  Gene,
  GeneConstraints,
  GeneDraft,
  GeneExpression,
  GeneIntent,
  GeneRequest,
  GeneSelection,
  GeneStep,
  GeneStepKind,
  GeneValidation,
  MintedGene,
  ScoredCandidate,
  SelectionPolicy,
} from "./types.ts";

/**
 * ⚠️ D88: the type declarations that used to live below now live in `types.ts`,
 * and are re-exported here so that **all 31 existing import sites keep working
 * unchanged**. Two lines are needed rather than one because a re-export does not
 * bring a name into this module's own scope, and this file still uses these shapes
 * locally — `GENE_INTENTS` right below is typed `readonly GeneIntent[]`, and
 * `DEFAULT_SELECTION_POLICY` is typed `SelectionPolicy`.
 *
 * The reason for the move is in `types.ts`'s header: a seam interface must not
 * import its types from an implementation module, or every seam author is coupled
 * to that implementation. This module keeps the behaviour; `types.ts` holds shapes.
 */
export type {
  Gene,
  GeneConstraints,
  GeneDraft,
  GeneExpression,
  GeneIntent,
  GeneRequest,
  GeneSelection,
  GeneStep,
  GeneStepKind,
  GeneValidation,
  MintedGene,
  ScoredCandidate,
  SelectionPolicy,
} from "./types.ts";

export const GENE_INTENTS: readonly GeneIntent[] = ["build", "fix", "research", "verify", "operate"];

/** Stable JSON: sorted keys, no incidental formatting. Same data, same bytes. */
export function canonicalize(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalize(v)}`).join(",")}}`;
}

/** Identity = content address of the canonical body. Editing forks the address. */
export function geneAddress(gene: Gene): string {
  return `sha256:${createHash("sha256").update(canonicalize(gene), "utf8").digest("hex")}`;
}

class GeneValidationError extends Error {}

function strings(value: unknown, what: string, options: { allowEmpty?: boolean } = {}): string[] {
  if (!Array.isArray(value) || (!options.allowEmpty && value.length === 0)) {
    throw new GeneValidationError(`${what} must be a non-empty array`);
  }
  return value.map((entry) => {
    if (typeof entry !== "string" || entry.trim() === "") throw new GeneValidationError(`${what} entries must be non-empty strings`);
    return entry;
  });
}

/**
 * Mint a Gene. Structural invariants refuse a draft here, so no caller can
 * bypass them: an acting strategy must carry a verify step (without one there
 * is no signal to evolve against), budgets must be positive, and validation
 * must be declared as claims the runtime can compare against the journal.
 */
export function mintGene(draft: GeneDraft): MintedGene {
  if (typeof draft.name !== "string" || draft.name.trim() === "") throw new GeneValidationError("name must be a non-empty string");
  if (!GENE_INTENTS.includes(draft.intent)) throw new GeneValidationError(`intent must be one of: ${GENE_INTENTS.join(", ")}`);
  const gene: Gene = {
    name: draft.name.trim(),
    intent: draft.intent,
    signalsMatch: strings(draft.signalsMatch, "signalsMatch"),
    preconditions: strings(draft.preconditions ?? [], "preconditions", { allowEmpty: true }),
    strategy: parseStrategy(draft.strategy ?? []),
    constraints: parseConstraints(draft.constraints),
    validation: parseValidation(draft.validation),
    avoid: strings(draft.avoid ?? [], "avoid", { allowEmpty: true }),
  };
  return { gene, address: geneAddress(gene) };
}

/**
 * Validation entries. A bare string is a hand-written command: kept verbatim and
 * reported as unverifiable rather than reinterpreted (D20). Structured claims are
 * checked for the fields their kind needs, so a malformed claim is refused at
 * mint rather than silently comparing as "met" later.
 */
export function parseValidation(entries: unknown): GeneValidation[] {
  if (!Array.isArray(entries) || entries.length === 0) {
    throw new GeneValidationError("validation must be a non-empty array");
  }
  return entries.map((entry, index) => {
    const where = `validation[${index}]`;
    if (typeof entry === "string") {
      if (entry.trim() === "") throw new GeneValidationError(`${where} must not be empty`);
      return { kind: "command", command: entry } as const;
    }
    if (entry === null || typeof entry !== "object") {
      throw new GeneValidationError(`${where} must be a string or an object with a known kind`);
    }
    const claim = entry as Record<string, unknown>;
    switch (claim.kind) {
      case "files-written": {
        const paths = strings(claim.paths, `${where}.paths`);
        return { kind: "files-written", paths } as const;
      }
      case "no-write":
        return { kind: "no-write" } as const;
      case "tool-used": {
        const [tool] = strings([claim.tool], `${where}.tool`);
        if (claim.times === undefined) return { kind: "tool-used", tool: tool! } as const;
        if (!Number.isSafeInteger(claim.times) || (claim.times as number) < 1) {
          throw new GeneValidationError(`${where}.times must be a positive integer when present`);
        }
        return { kind: "tool-used", tool: tool!, times: claim.times as number } as const;
      }
      case "command": {
        const [command] = strings([claim.command], `${where}.command`);
        return { kind: "command", command: command! } as const;
      }
      default:
        throw new GeneValidationError(`${where}.kind must be one of: files-written, no-write, tool-used, command`);
    }
  });
}

function parseStrategy(steps: readonly GeneStep[]): GeneStep[] {
  const kinds = new Set<GeneStepKind>(["guard", "act", "verify", "rollback"]);
  const parsed = steps.map((step) => {
    if (step === null || typeof step !== "object" || !kinds.has(step.kind as GeneStepKind) || typeof step.text !== "string" || step.text.trim() === "") {
      throw new GeneValidationError("each strategy step needs a known kind and non-empty text");
    }
    return { kind: step.kind, text: step.text.trim() } as GeneStep;
  });
  if (parsed.length === 0) throw new GeneValidationError("strategy must not be empty");
  if (parsed.some((step) => step.kind === "act") && !parsed.some((step) => step.kind === "verify")) {
    throw new GeneValidationError("a strategy that acts must also verify: without a verify step there is nothing to evolve against");
  }
  return parsed;
}

function parseConstraints(constraints: unknown): GeneConstraints {
  if (constraints === null || typeof constraints !== "object") throw new GeneValidationError("constraints must be an object");
  const raw = constraints as Record<string, unknown>;
  const positive = (value: unknown, what: string): number => {
    if (!Number.isInteger(value) || (value as number) < 1) throw new GeneValidationError(`${what} must be a positive integer`);
    return value as number;
  };
  return { maxFiles: positive(raw.maxFiles, "constraints.maxFiles"), maxLines: positive(raw.maxLines, "constraints.maxLines"), forbiddenPaths: strings(raw.forbiddenPaths ?? [], "constraints.forbiddenPaths", { allowEmpty: true }) };
}

/**
 * Laplace smoothing (1 pseudo-success / 1 pseudo-attempt) keeps a 1/1 gene from
 * outranking a 9/10 gene; recency decays *confidence*, never the record.
 *
 * ⚠️ D88: the four interfaces that surrounded this constant — `GeneExpression`,
 * `SelectionPolicy`, `GeneRequest`, `ScoredCandidate` — moved to `types.ts` and are
 * re-exported at the top of this file. **This constant stayed because it is a
 * value, and it is also the concrete reason a re-export alone was not enough**: it
 * is typed `SelectionPolicy`, so this module needs that name in its own scope, and
 * `export type { … } from "./types.ts"` does not provide one.
 */
export const DEFAULT_SELECTION_POLICY: SelectionPolicy = {
  signalWeight: 1,
  reliabilityWeight: 1,
  recencyWeight: 0.5,
  priorSuccesses: 1,
  priorAttempts: 1,
  halfLifeMs: 30 * 24 * 60 * 60 * 1000,
  quarantineStreak: 2,
};

/**
 * Score every candidate. Intent is a gate, not a weight: a gene of the wrong
 * kind of work is excluded before signals are weighed. A gene that claims none
 * of the request's vocabulary is excluded too — applying an unrelated
 * strategy is noise wearing a badge.
 */
export function scoreCandidates(
  candidates: ReadonlyArray<{ address: string; gene: Gene; expression: GeneExpression }>,
  request: GeneRequest,
  policy: SelectionPolicy = DEFAULT_SELECTION_POLICY,
  now: number = Date.now(),
): ScoredCandidate[] {
  const tokens = new Set<string>([...request.signals.map((signal) => signal.toLowerCase()), ...request.signals]);
  const text = request.text.toLowerCase();
  return candidates.map(({ address, gene, expression }) => {
    if (gene.intent !== request.intent) {
      return { address, gene, score: 0, overlap: 0, reliability: 0, recency: 0, excluded: `intent ${gene.intent} does not match ${request.intent}` };
    }
    // Substring matching is what makes Chinese work: a gene signal like
    // "小程序开发" has no word boundaries to tokenize against.
    const matched = gene.signalsMatch.filter((signal) => {
      const lower = signal.toLowerCase();
      return tokens.has(lower) || text.includes(lower);
    }).length;
    // ⚠️ D110: `overlap` is normalized by the *gene's own* breadth, not by the
    // request's signals and not by a union. That makes it asymmetric, and the
    // asymmetry has a direction: a gene listing one signal that matches scores 1.0
    // and cannot lose on this term, while a gene listing ten signals of which three
    // match scores 0.3. Strictly more knowledge about when a gene applies therefore
    // scores *lower* for the same hit, so this term rewards writing narrow
    // `signalsMatch` lists.
    //
    // Measured, not argued (test/weight-ablation.test.ts): with `signalWeight: 1`,
    // that 1.0-against-0.5 gap outweighs a reliability gap of 6/10 against 8/10, so
    // a gene wins for listing fewer words rather than for working better. The
    // crossover is at `signalWeight` 0.25 or below.
    //
    // ⚠️ Imitating EvoMap does not fix this by changing the weight. Their ratio is
    // health 0.6 to signal-match 0.4 (`geneSelection.d.ts:194-195`), i.e. about 1.5
    // to 1, which sits *above* that crossover; and their overlap is a different
    // metric anyway — symmetric and IDF-weighted, via `bagCosine` /
    // `idfTagOverlapScore` (`geneSelection.js` importing from `signals/expand.js`).
    // ⚠️ The 0.04 figure D107 cited as "signals_match is weak evidence" is the
    // separate `TASK_DOMAIN_WEIGHT` factor, not this term (corrected in D110).
    //
    // Left as-is deliberately rather than fixed here, because changing it moves every
    // score in every existing ledger row and is a change of metric rather than of
    // tuning. Recorded so the next person does not have to rediscover it: this
    // property was unknown until an ablation built to test something else failed.
    const overlap = gene.signalsMatch.length === 0 ? 0 : matched / gene.signalsMatch.length;
    if (overlap === 0) {
      return { address, gene, score: 0, overlap, reliability: 0, recency: 0, excluded: "no signal overlap" };
    }
    // A failure streak is the one signal a score cannot express: enough
    // consecutive failures mean the gene is not merely less likely to work, it
    // is currently unproven, and only a new success takes it back out.
    if (expression.streak >= policy.quarantineStreak) {
      return { address, gene, score: 0, overlap, reliability: 0, recency: 0, excluded: `${expression.streak} consecutive failures` };
    }
    const reliability = (expression.successes + policy.priorSuccesses) / (expression.attempts + policy.priorSuccesses + policy.priorAttempts);
    const recency = expression.lastSuccessAt === null ? 0 : Math.pow(0.5, Math.max(0, now - expression.lastSuccessAt) / policy.halfLifeMs);
    const score = policy.signalWeight * overlap + policy.reliabilityWeight * reliability + policy.recencyWeight * recency;
    return { address, gene, score, overlap, reliability, recency, excluded: null };
  });
}

export function selectGene(
  candidates: ReadonlyArray<{ address: string; gene: Gene; expression: GeneExpression }>,
  request: GeneRequest,
  policy?: SelectionPolicy,
  now?: number,
): GeneSelection {
  const scored = scoreCandidates(candidates, request, policy, now);
  const ranked = scored
    .filter((candidate) => candidate.excluded === null)
    .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address));
  const selection = ranked[0] ?? null;
  // Equal scores mean the line above chose by address order, i.e. by the
  // alphabetical position of a content hash. Kept, because a selector that is not
  // deterministic stops being auditable; reported, because a choice made by an
  // arbitrary string must not look like one made by evidence (D107).
  const runnerUp = ranked[1];
  return { selection, ranked, tieBrokenByAddress: selection !== null && runnerUp !== undefined && runnerUp.score === selection.score };
}

/**
 * Exploration intensity: how often selection should take something other than the
 * top-ranked candidate (D107, shape from EvoMap's `computeDriftIntensity`).
 *
 * `1/sqrt(ne)` plus an offset that decays from `offsetStart` to `offsetFloor` as
 * the pool matures, where maturity is `totalAttempts / (ne * attemptsPerGene)`.
 * A pool of one or fewer gets a fixed high intensity.
 *
 * Two things about this shape are the point, and both are measured rather than
 * tasteful. First, it is **self-tuning**: a library holding a handful of genes
 * explores almost always, and exploration fades as evidence accumulates — so
 * D106's starvation trap (a new gene scores low, is never selected, and therefore
 * never earns the evidence that would raise it) is fixed without adding a weight
 * that favours new genes. Second, the decay is by *total attempts across the pool*,
 * not by age: a library that is old but barely used has not matured, and treating
 * elapsed time as evidence would let an idle gene look proven.
 *
 * EvoMap's own numbers are `1/sqrt(Ne)`, offset `0.3 → 0.02`, maturity at
 * `Ne * 10` attempts, and `0.7` for `Ne <= 1`. They are reproduced as defaults here
 * rather than imported, because this project has zero production dependencies and
 * because a constant whose provenance is a comment is auditable in a way a
 * transitive dependency is not.
 */
export function computeDriftIntensity(
  geneCount: number,
  totalAttempts: number,
  options: { offsetStart?: number; offsetFloor?: number; attemptsPerGene?: number; tinyPoolIntensity?: number } = {},
): number {
  const offsetStart = options.offsetStart ?? 0.3;
  const offsetFloor = options.offsetFloor ?? 0.02;
  const attemptsPerGene = options.attemptsPerGene ?? 10;
  const tiny = options.tinyPoolIntensity ?? 0.7;
  if (!Number.isFinite(geneCount) || geneCount <= 1) return tiny;
  const budget = geneCount * attemptsPerGene;
  // Clamped to [0,1] so a pool that has outrun its budget keeps the floor rather
  // than driving the offset negative, which would make maturity *reduce*
  // exploration below the floor it was designed to settle at.
  const maturity = budget <= 0 ? 1 : Math.min(1, Math.max(0, totalAttempts / budget));
  const offset = offsetStart + (offsetFloor - offsetStart) * maturity;
  return Math.min(1, Math.max(0, 1 / Math.sqrt(geneCount) + offset));
}

/**
 * Pick which ranked candidate to take (D107, shape from EvoMap's `driftSelect`).
 *
 * Returns an index into the ranked list, so the caller keeps owning the list and
 * `selectGene` stays deterministic. That separation is deliberate and load-bearing:
 * folding randomness into `selectGene` would break the property the tie-break was
 * kept for — the same library giving the same answer — and would make every
 * existing assertion about which gene was selected into a coin flip.
 *
 * With probability `intensity`, take a uniformly random candidate from the top
 * `windowSize`; otherwise take index 0. `rng` is called **at most twice**, once for
 * the decision and once for the pick, so a test can drive it with a fixed pair of
 * numbers and know exactly which branch it exercised. A window that grows with
 * intensity is what keeps a high-intensity pool from reaching the bottom of the
 * ranking, where the candidates the hard gates admitted but the score rejected live.
 *
 * `ponytail:` the window is `1 + floor(intensity * (count - 1))` rather than
 * EvoMap's separately-tuned `explorationWindowSize`, which is shared with its UCB1
 * policy. We have one policy, so a second tuning surface would be a knob with
 * nothing to turn.
 */
export function driftIndex(
  rankedCount: number,
  intensity: number,
  rng: () => number,
): { index: number; drifted: boolean; intensity: number; windowSize: number } {
  if (rankedCount <= 1) return { index: 0, drifted: false, intensity, windowSize: Math.max(0, rankedCount) };
  const clamped = Number.isFinite(intensity) ? Math.min(1, Math.max(0, intensity)) : 0;
  const windowSize = Math.min(rankedCount, 1 + Math.floor(clamped * (rankedCount - 1)));
  const roll = rng();
  if (!(roll < clamped)) return { index: 0, drifted: false, intensity: clamped, windowSize };
  const pick = rng();
  // A malformed rng must not buy an out-of-range index: falling back to the top
  // candidate is the same direction as every other fail-closed choice here.
  const index = Number.isFinite(pick) ? Math.min(windowSize - 1, Math.max(0, Math.floor(pick * windowSize))) : 0;
  return { index, drifted: index !== 0, intensity: clamped, windowSize };
}
