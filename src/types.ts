/**
 * Core message, tool and model contracts.
 *
 * The runtime only ever talks to a {@link ModelAdapter}; the concrete provider
 * (OpenAI-compatible HTTP, a local server, or the offline mock) is chosen at
 * the edge, so swapping models never touches the loop.
 *
 * Tool-calling uses the OpenAI function-calling shape verbatim, because the
 * HTTP adapter already speaks that dialect. Inventing a private protocol would
 * only add a translation layer that can drift from the wire format.
 */

import type { TaskIntent } from "./taskspec.ts";

export type Role = "system" | "user" | "assistant" | "tool";

/* ------------------------------------------------------------------------- *
 * Domain types: gene, task state, round evidence (moved here by D88).
 *
 * ⚠️ Why these live here rather than in the modules that implement them. A seam
 * is an interface other code programs against, and an interface that imports its
 * types from an implementation module couples every seam author to that
 * implementation. This was the recorded precondition for building the tools seam:
 * extract these types first, or the seam copies the same leak. `gene.ts`,
 * `task-state.ts` and `validation.ts` keep their functions and constants and
 * re-export these names, so all 31 existing import sites keep working unchanged —
 * the move adds a neutral surface without breaking a single caller.
 *
 * What deliberately did not move:
 * - `WeakenedTaskStateError` is `export class … extends Error {}`, a runtime value
 *   rather than a type, so it cannot live in a module meant to erase at compile
 *   time. It stays in `task-state.ts`.
 * - Every function and constant stays (`canonicalize`, `geneAddress`, `mintGene`,
 *   `parseValidation`, `scoreCandidates`, `selectGene`, `assertNotWeakened`,
 *   `assessTaskState`, `checkValidation`, the `format*` family,
 *   `MAX_TASK_STATE_BYTES`, `GENE_INTENTS`, `DEFAULT_SELECTION_POLICY`). This
 *   module holds shapes, not behaviour.
 *
 * ⚠️ The import above is load-bearing for the acyclicity argument. `types.ts` was
 * a leaf with in-degree 7 and out-degree 0. The cheap alternative to this move was
 * to make it a barrel re-exporting from the three implementation modules — one edit
 * instead of seven — and that would have inverted the layering: the module
 * everything depends on would depend on implementations, and anything importing
 * `ChatMessage` would name `gene.ts` transitively. So the declarations moved
 * instead, and this module's only outgoing edge is to `taskspec.ts`, which itself
 * imports nothing at all. **⇒ `types.ts` cannot appear in a cycle: a cycle would
 * need a path back from `taskspec.ts`, and there is none.** That is a proof from
 * the import list rather than a measurement of today's graph, which is why it is
 * written down here instead of left in a commit message.
 * ------------------------------------------------------------------------- */

/** Same set as TaskSpec's intent: the spec is the front door to selection. */
export type GeneIntent = TaskIntent;

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

/**
 * A validation entry: an observable fact the round must show, or — as a bare
 * string written before this existed — a command kept verbatim and reported as
 * unverifiable until a runner exists (D20).
 */
export type GeneValidation =
  | { readonly kind: "files-written"; readonly paths: readonly string[] }
  | { readonly kind: "no-write" }
  | { readonly kind: "tool-used"; readonly tool: string; readonly times?: number }
  | { readonly kind: "command"; readonly command: string };

/** An immutable capability unit. Superseded, never edited. */
export interface Gene {
  readonly name: string;
  readonly intent: GeneIntent;
  /** Vocabulary whose presence makes this Gene a retrieval candidate. */
  readonly signalsMatch: readonly string[];
  readonly preconditions: readonly string[];
  readonly strategy: readonly GeneStep[];
  /** Recorded at mint; enforced mechanically by the write gate (D18). */
  readonly constraints: GeneConstraints;
  /** Claims the round must show. Checked against the journal (D20). */
  readonly validation: readonly GeneValidation[];
  /** Compact warnings from past failures — never naive appended prose. */
  readonly avoid: readonly string[];
}

/**
 * A gene draft as callers may write it: `validation` accepts bare strings for
 * convenience and for drafts written before claims existed, and `mintGene`
 * normalises them to a `command` claim.
 */
export type GeneDraft = Omit<Gene, "validation"> & { readonly validation: readonly (GeneValidation | string)[] };

/** A minted gene: the body plus the identity derived from it. */
export interface MintedGene {
  readonly gene: Gene;
  readonly address: string;
}

/** What a gene's usage has actually been. Counters only; identity lives in the body. */
export interface GeneExpression {
  attempts: number;
  successes: number;
  /**
   * When this gene last *worked*. Confidence is about the last proof, not the
   * last attempt: a gene that just failed has not become more current.
   */
  lastSuccessAt: number | null;
  /** Consecutive failures since the last success. */
  streak: number;
}

export interface SelectionPolicy {
  readonly signalWeight: number;
  readonly reliabilityWeight: number;
  readonly recencyWeight: number;
  readonly priorSuccesses: number;
  readonly priorAttempts: number;
  readonly halfLifeMs: number;
  /** Consecutive failures that take a gene out of selection until it is re-proven. */
  readonly quarantineStreak: number;
}

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

export interface GeneSelection {
  /** The top live candidate, or null when every candidate was excluded. */
  readonly selection: ScoredCandidate | null;
  /** Live candidates, best first. */
  readonly ranked: readonly ScoredCandidate[];
  /**
   * True when the winner and the runner-up scored identically, so the ordering
   * that actually chose between them was `address.localeCompare` — a content hash's
   * alphabetical order, which has nothing to do with capability (D107).
   *
   * The tie-break itself is not the defect and is deliberately kept: a selector
   * must be deterministic, or the same library stops giving the same answer. What
   * was wrong is that it decided *silently*, so a choice made by an arbitrary
   * string order was indistinguishable from one made by evidence. EvoMap states the
   * same rule for its own selector — 「可解释的选择决策（禁黑盒）」 — and abstains
   * outright when the spread cannot discriminate (`plateau_flat_match`).
   *
   * Reporting it is the minimal honest step and a prerequisite for the next one:
   * the drift stage D107 adopts needs to know when the ranking cannot tell
   * candidates apart, and this flag is exactly that fact. Callers that must not
   * act on an arbitrary choice can now check it; nothing is forced to.
   */
  readonly tieBrokenByAddress: boolean;
}

export interface TaskStateStep {
  /** Prose. Not authority — the claim is. May be rewritten freely. */
  readonly text: string;
  /**
   * The acceptance criterion, as an observable fact. Absent means the step has
   * no criterion yet, which is reported as an unknown rather than as progress.
   */
  readonly claim?: GeneValidation;
}

/** What a writer supplies. Note what is absent: no `done`, no `outcome`. */
export interface TaskStateInput {
  /** Prose progress. Freely rewritable; it is context, not a record of fact. */
  readonly state: string;
  readonly steps: readonly TaskStateStep[];
}

export interface AssessedStep {
  readonly text: string;
  readonly claim?: GeneValidation;
  /** Absent when the step has no claim — that is an unknown, not a pass. */
  readonly outcome?: ClaimOutcome;
  /** Why the outcome is what it is, in observable terms. */
  readonly detail?: string;
}

export interface TaskStateAssessment {
  readonly steps: readonly AssessedStep[];
  /**
   * True only when there is at least one step and every one of them is `met`.
   * Mirrors `checkValidation.satisfied`: an empty state is not complete, and an
   * `unverifiable` step is not met.
   */
  readonly complete: boolean;
  /** Steps with no criterion, or one this runtime cannot decide. */
  readonly unknowns: readonly string[];
  /** Steps whose criterion was decided and contradicted. */
  readonly failed: readonly string[];
}

/** What a round left behind, as the journal recorded it. */
export interface RoundEvidence {
  /** Paths the round actually wrote, in order. */
  readonly filesWritten: readonly string[];
  /** Tools the round actually called, in order. */
  readonly tools: readonly string[];
}

export type ClaimOutcome = "met" | "unmet" | "unverifiable";

/** A tool invocation requested by the model. Arguments stay raw text. */
export interface ToolCall {
  id: string;
  name: string;
  /**
   * The model's arguments as it emitted them. Kept as a string rather than a
   * parsed object so invalid JSON is preserved for the tool to reject loudly
   * instead of being silently coerced into `{}`.
   */
  arguments: string;
}

export interface ChatMessage {
  role: Role;
  content: string;
  /** Assistant messages only: the calls this turn requested. */
  toolCalls?: ToolCall[];
  /** Tool messages only: the call this message answers. */
  toolCallId?: string;
}

/** JSON Schema subset describing a tool's parameters. */
export interface JsonSchema {
  type: "object";
  properties?: Record<string, unknown>;
  required?: string[];
  [key: string]: unknown;
}

/** A tool as advertised to the model. */
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ChatRequest {
  messages: ChatMessage[];
  /** Tools offered for this turn; omitted when the caller runs without tools. */
  tools?: ToolDefinition[];
  /** Adapter-specific model id; falls back to the adapter's configured default. */
  model?: string;
  temperature?: number;
}

export interface ChatUsage {
  inputTokens: number;
  outputTokens: number;
  /**
   * Provider-reported share of {@link outputTokens} spent on the model's private
   * reasoning, when the provider reports it (e.g. `completion_tokens_details.
   * reasoning_tokens`). It is a *subset* marker for explaining a large output
   * count, never added on top: this project reports the number the provider gave
   * and does not independently verify the subset relation.
   */
  reasoningTokens?: number;
}

export interface ChatResponse {
  content: string;
  /**
   * The model's reasoning trace, when the provider exposes one (`reasoning_content`
   * on the wire). Deliberately NOT part of {@link ChatMessage}: reasoning is
   * derived, verbose, and never replayed, so keeping it off the message type makes
   * "it is not persisted and not sent back" a property of the shape rather than a
   * rule someone has to remember.
   */
  reasoning?: string;
  /** Calls the model wants executed before it can continue. */
  toolCalls: ToolCall[];
  model: string;
  usage: ChatUsage;
}

/** Every model provider implements exactly this. */
export interface ModelAdapter {
  readonly id: string;
  readonly defaultModel: string;
  chat(request: ChatRequest, signal?: AbortSignal): Promise<ChatResponse>;
}
