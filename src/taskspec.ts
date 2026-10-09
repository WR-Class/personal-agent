/**
 * TaskSpec: what this send is for, decided before the model is called.
 *
 * Mechanism borrowed from dsh-lab's dsh-orchestrator (recorded as D12): a
 * deterministic, versioned spec built from the user's input; the mode is set
 * by the runtime, never by the model; a missing objective is recorded as an
 * unknown, never invented; enforcement is a separate, default-off switch.
 *
 * Schema 2 adds `signals`: the request vocabulary that gene selection weighs
 * (D14). The spec is the front door — its intent gates the gene library, its
 * signals score it.
 */
export const TASKSPEC_VERSION = 2;

import { classifyIntent } from "./intent-classifier.ts";
import type { HistoryRound } from "./intent-classifier.ts";

/** The one mode this runtime runs today. The runtime sets it; the model cannot. */
export const TASK_MODE = "single-agent";

export type TaskIntent = "build" | "fix" | "research" | "verify" | "operate";

export interface TaskSpec {
  schema: number;
  /** The user's own words, preserved verbatim. */
  originalInput: string;
  objective: string;
  /** Keyword classification, deterministic but not authority. */
  intent: TaskIntent;
  /** Request vocabulary for gene selection: tokens plus the raw text stay available for substring matching. */
  signals: string[];
  /** Set by the runtime. Undefined means no mode was decided — never guessed. */
  selectedMode?: string;
  /** Which required facts were missing. Empty means the spec is complete. */
  unknowns: string[];
  evidence: { authoritativeMode: boolean };
}

/** Structured input keeps its first text part, mirroring dsh-orchestrator. */
type SpecInput = string | { content?: ReadonlyArray<{ type?: string; text?: string } & Record<string, unknown>> };

// Intent classification (D124): a Jev-distilled classifier in
// `intent-classifier.ts` reads `intent-weights.json` and averages the
// training-set probability vectors for every signal in the prompt. The
// regex table is the OOV fallback: when no signal hits the weights, this
// is the only routing signal we have, and it covers the operators people
// type before any training data exists.
const INTENT_HINTS: ReadonlyArray<readonly [TaskIntent, RegExp]> = [
  ["operate", /部署|上线|运维|维护|服务器|infra(?!-read|structure)|\bsystem\b|operate|deploy/i],
];

// ponytail: any top-probability under this means the classifier saw zero
// matching signals and the priors carried the decision. We only trust the
// regex when the classifier has nothing better to say.
const OOV_THRESHOLD = 0.5;

function firstText(input: SpecInput): string {
  if (typeof input === "string") return input;
  for (const part of input.content ?? []) {
    if (part.type === "text" && typeof part.text === "string") return part.text;
  }
  return "";
}

/**
 * Extract the request vocabulary gene selection matches against. Word tokens
 * for languages that have them; a Chinese run has no spaces to split on, so it
 * also contributes its 2-character n-grams — otherwise a whole sentence is one
 * signal, which matches nothing and (worse) groups nothing when repeated
 * failures are distilled.
 */
export function extractSignals(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (normalized === "") return [];
  const signals = new Set<string>();
  for (const token of normalized.split(/\s+/u)) {
    if (token.length <= 1) continue;
    // CJK has no word boundaries: emit the bigrams so the vocabulary is shared
    // between differently phrased requests. The whole run is only kept when it
    // is short enough to be a word rather than a whole sentence.
    if (isCjk(token)) {
      for (let index = 0; index + 1 < token.length; index++) signals.add(token.slice(index, index + 2));
      if (token.length <= 4) signals.add(token);
      continue;
    }
    signals.add(token);
  }
  return [...signals];
}

function isCjk(token: string): boolean {
  return /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]+$/u.test(token);
}

export function buildTaskSpec(input: SpecInput, options: { mode?: string; history?: ReadonlyArray<HistoryRound> } = {}): TaskSpec {
  const originalInput = firstText(input);
  const objective = originalInput.trim();
  const unknowns: string[] = [];
  if (objective === "") unknowns.push("objective");
  // ponytail: classifier only fires when at least one signal is in the
  // weight table; otherwise the OOV prior carries it and we lean on the
  // operator-keyword regex or fall through to the build default. The
  // Jev training set is small and "normal work" with no signal is not its
  // problem to solve. v5 (D138) adds an optional `history` so the
  // classifier can blend in the previous round's intent and AI state;
  // omitting it keeps the v1 behaviour for callers that have no session.
  const c = classifyIntent(originalInput, options.history);
  let intent: TaskIntent = c.intent;
  if (c.oov) {
    intent = "build";
    for (const [candidate, hint] of INTENT_HINTS) {
      if (hint.test(originalInput)) { intent = candidate; break; }
    }
  }
  // TASK_MODE is the runtime's actual default; an unspecified `mode` is not
  // unknown, it is this. Recording it as unknown would mislead any operator
  // reading the spec — they would look for a missing value the runtime never
  // had to give.
  const selectedMode = options.mode ?? TASK_MODE;
  return {
    schema: TASKSPEC_VERSION,
    originalInput,
    objective,
    intent,
    signals: extractSignals(originalInput),
    selectedMode,
    unknowns,
    evidence: { authoritativeMode: true },
  };
}

/**
 * Enforcement is a separate switch and defaults to off, exactly as in the
 * reference: an incomplete spec is reported, not treated as fatal, until the
 * operator opts into hard refusal.
 */
export function assessTaskSpec(spec: TaskSpec, options: { enforce?: boolean } = {}): { blocked: boolean; reason?: string } {
  if (!options.enforce || spec.unknowns.length === 0) return { blocked: false };
  return { blocked: true, reason: `task spec incomplete: ${spec.unknowns.join(", ")}` };
}
