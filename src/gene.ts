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

/** Same set as TaskSpec's intent: the spec is the front door to selection. */
export type GeneIntent = TaskIntent;
export const GENE_INTENTS: readonly GeneIntent[] = ["build", "fix", "research", "verify", "operate"];

export type GeneStepKind = "guard" | "act" | "verify" | "rollback";

export interface GeneStep {
  readonly kind: GeneStepKind;
  readonly text: string;
}

export interface GeneConstraints {
  readonly maxFiles: number;
  readonly maxLines: number;
  readonly forbiddenPaths: readonly string[];
}

/** An immutable capability unit. Superseded, never edited. */
export interface Gene {
  readonly name: string;
  readonly intent: GeneIntent;
  /** Vocabulary whose presence makes this Gene a retrieval candidate. */
  readonly signalsMatch: readonly string[];
  readonly preconditions: readonly string[];
  readonly strategy: readonly GeneStep[];
  /** Recorded at mint; enforced by the write gate once that slice exists. */
  readonly constraints: GeneConstraints;
  /** Commands that prove the strategy worked. Empty until M3 can run them. */
  readonly validation: readonly string[];
  /** Compact warnings from past failures — never naive appended prose. */
  readonly avoid: readonly string[];
}

/** A minted gene: the body plus the identity derived from it. */
export interface MintedGene {
  readonly gene: Gene;
  readonly address: string;
}

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
 * must be declared so M3 can enforce the admission gate mechanically later.
 */
export function mintGene(draft: Gene): MintedGene {
  if (typeof draft.name !== "string" || draft.name.trim() === "") throw new GeneValidationError("name must be a non-empty string");
  if (!GENE_INTENTS.includes(draft.intent)) throw new GeneValidationError(`intent must be one of: ${GENE_INTENTS.join(", ")}`);
  const gene: Gene = {
    name: draft.name.trim(),
    intent: draft.intent,
    signalsMatch: strings(draft.signalsMatch, "signalsMatch"),
    preconditions: strings(draft.preconditions ?? [], "preconditions", { allowEmpty: true }),
    strategy: parseStrategy(draft.strategy ?? []),
    constraints: parseConstraints(draft.constraints),
    validation: strings(draft.validation, "validation"),
    avoid: strings(draft.avoid ?? [], "avoid", { allowEmpty: true }),
  };
  return { gene, address: geneAddress(gene) };
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

/** What a gene's usage has actually been. Counters only; identity lives in the body. */
export interface GeneExpression {
  attempts: number;
  successes: number;
  lastAt: number | null;
}

export interface SelectionPolicy {
  readonly signalWeight: number;
  readonly reliabilityWeight: number;
  readonly recencyWeight: number;
  readonly priorSuccesses: number;
  readonly priorAttempts: number;
  readonly halfLifeMs: number;
}

/**
 * Laplace smoothing (1 pseudo-success / 1 pseudo-attempt) keeps a 1/1 gene from
 * outranking a 9/10 gene; recency decays *confidence*, never the record.
 */
export const DEFAULT_SELECTION_POLICY: SelectionPolicy = {
  signalWeight: 1,
  reliabilityWeight: 1,
  recencyWeight: 0.5,
  priorSuccesses: 1,
  priorAttempts: 1,
  halfLifeMs: 30 * 24 * 60 * 60 * 1000,
};

export interface GeneRequest {
  readonly intent: GeneIntent;
  readonly signals: readonly string[];
  readonly text: string;
}

export interface ScoredCandidate {
  readonly address: string;
  readonly gene: Gene;
  readonly score: number;
  readonly overlap: number;
  readonly reliability: number;
  readonly recency: number;
  /** Why this candidate was excluded, or null when it is live. */
  readonly excluded: string | null;
}

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
    const overlap = gene.signalsMatch.length === 0 ? 0 : matched / gene.signalsMatch.length;
    if (overlap === 0) {
      return { address, gene, score: 0, overlap, reliability: 0, recency: 0, excluded: "no signal overlap" };
    }
    const reliability = (expression.successes + policy.priorSuccesses) / (expression.attempts + policy.priorSuccesses + policy.priorAttempts);
    const recency = expression.lastAt === null ? 0 : Math.pow(0.5, Math.max(0, now - expression.lastAt) / policy.halfLifeMs);
    const score = policy.signalWeight * overlap + policy.reliabilityWeight * reliability + policy.recencyWeight * recency;
    return { address, gene, score, overlap, reliability, recency, excluded: null };
  });
}

export interface GeneSelection {
  /** The top live candidate, or null when every candidate was excluded. */
  readonly selection: ScoredCandidate | null;
  /** Live candidates, best first. */
  readonly ranked: readonly ScoredCandidate[];
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
  return { selection: ranked[0] ?? null, ranked };
}
