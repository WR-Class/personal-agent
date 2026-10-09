/**
 * Intent classifier distilled from Jev.
 *
 * Each signal s in `weights.signals` carries the mean Jev probability vector
 * across training prompts that contained s. At inference we average those
 * vectors over the prompt's signals, softmax, and return the top intent.
 * The model is data, not code: a 60-prompt distillation baked into
 * `intent-weights.json` (~6 KB) replaces the old regex table.
 *
 * Out-of-vocabulary signals use the global `priors` (mean of all Jev
 * probabilities over the training set). When no signals match, priors
 * drive the decision — usually a near-uniform "build" with a small bias.
 *
 * Margin- and OOV-driven history blend (v4/D137): the signal-based result
 * is trusted in proportion to how decisively it points at one intent.
 *
 * AI-state context (v5/D138): the user's prompt is meaningful only against
 * the AI's last known state. Each round of history can carry an `aiState`
 * summary (didWhat / completed / planNext). When that
 * summary includes a `planNext`, the history weight goes up because we
 * know exactly what the user is likely continuing toward. Loop detection
 * watches the last three rounds and flags when the AI state has not
 * progressed — useful for catching the "user says 继续 forever" pattern.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { extractSignals } from "./taskspec.ts";
import type { TaskIntent } from "./taskspec.ts";

const INTENTS: readonly TaskIntent[] = ["fix", "verify", "research", "operate", "build"] as const;

interface Weights {
  signals: Record<string, Record<TaskIntent, number>>;
  counts: Record<string, number>;
  priors: Record<TaskIntent, number>;
  trainedAt: string;
  rows: number;
}

// ponytail: ~6 KB JSON, read once at module init so the classifier stays
// cheap enough to call from the synchronous `buildTaskSpec` path.
const WEIGHTS: Weights = JSON.parse(readFileSync(resolve(process.cwd(), "src/intent-weights.json"), "utf8")) as Weights;

const MARGIN_TRUST_FLOOR = 0.05;
const OOV_HISTORY_WEIGHT = 0.6;
// planNext gives us "what the AI said it would do next" — a stronger
// signal than the round-level intent. Boost history weight when present.
const PLAN_NEXT_OOV_BOOST = 0.1;
const PLAN_NEXT_SIGNAL_BOOST = 0.2;
const PLAN_NEXT_MAX_WEIGHT = 0.5;
// Loop detection (D142): watch the last 5 rounds and flag when one
// action signature dominates the window. 5 is wide enough to catch
// "AI keeps going back to file X" (not just "3 in a row exact same"),
// narrow enough to fire while the user still cares.
const LOOP_DETECT_WINDOW = 5;
// A loop fires when one action signature appears at least this many
// times AND this share of all actions in the window.
const LOOP_MIN_DOMINANT_COUNT = 3;
const LOOP_MIN_DOMINANT_RATIO = 0.5;

export interface AIState {
  /** Brief description of what the AI did in this round. */
  didWhat: string;
  /** Whether the AI actually completed the planned work. */
  completed: boolean;
  /** What the AI said it would do next (free text, optional). */
  planNext?: string;
  /** Per-tool-call fingerprints of every action this round took. D142
   *  feeds this to the loop detector: when the same fingerprint appears
   *  in ≥ 3 of the last 5 rounds AND dominates the window, the AI is
   *  stuck on the same target. Missing on rounds recorded before D142,
   *  which the detector treats as "no data" rather than "no actions". */
  actionSigs?: string[];
}

export interface HistoryRound {
  intent: TaskIntent;
  prompt: string;
  /** End-of-round AI state summary. v5 features (planNext inheritance,
   *  loop detection) only kick in when present. */
  aiState?: AIState;
}

export interface LoopSignal {
  detected: boolean;
  /** Number of trailing rounds the detector looked at (3–5). 0 when not detected. */
  roundsSinceProgress: number;
  /** Human-readable reason for the loop detection (or its absence). */
  reason: string;
}

export interface Classification {
  intent: TaskIntent;
  probability: number;
  alternatives: { intent: TaskIntent; probability: number }[];
  oov: boolean;
  /** v5: loop signal if the recent AI state has not progressed. */
  loop?: LoopSignal;
}

function distributionOf(c: Classification): Record<TaskIntent, number> {
  // Reconstruct the full 5-intent vector from a ranked classification.
  const out: Record<TaskIntent, number> = { fix: 0, verify: 0, research: 0, operate: 0, build: 0 };
  out[c.intent] = c.probability;
  for (const a of c.alternatives) {
    out[a.intent] = a.probability;
  }
  return out;
}

function historyWeightFor(base: Classification, last: HistoryRound): number {
  // ponytail: three structural facts drive the answer —
  //  (1) whether the prompt matched any signal (OOV)
  //  (2) how decisively the matched result points at one intent (margin)
  //  (3) whether the AI left a planNext describing what comes next
  // No phrase lists, no length checks, no signal-count thresholds.
  if (base.oov) {
    return OOV_HISTORY_WEIGHT + (last.aiState?.planNext ? PLAN_NEXT_OOV_BOOST : 0);
  }
  const second = base.alternatives[0]?.probability ?? 0;
  const margin = base.probability - second;
  const baseWeight = Math.max(0, MARGIN_TRUST_FLOOR - margin);
  if (last.aiState?.planNext && baseWeight > 0) {
    return Math.min(baseWeight + PLAN_NEXT_SIGNAL_BOOST, PLAN_NEXT_MAX_WEIGHT);
  }
  return baseWeight;
}

function detectLoop(history: ReadonlyArray<HistoryRound>): LoopSignal {
  if (history.length < LOOP_DETECT_WINDOW) {
    return { detected: false, roundsSinceProgress: 0, reason: "history too short" };
  }
  // ponytail: a "no progress" loop requires aiState + actionSigs on every
  // watched round. Histories recorded before D142 simply lack the field —
  // they are not loops, they are pre-loop-era data.
  const window = history.slice(-LOOP_DETECT_WINDOW);
  if (window.some((r) => !r.aiState)) {
    return { detected: false, roundsSinceProgress: 0, reason: "missing aiState in window" };
  }
  if (window.some((r) => !r.aiState!.actionSigs)) {
    return { detected: false, roundsSinceProgress: 0, reason: "missing actionSigs in window" };
  }

  // Flatten the window into a single list of action signatures. A round
  // that called three tools contributes three entries, not one — so a
  // round that did real work weighs more than a round that just thought.
  const allSigs: string[] = [];
  for (const r of window) {
    for (const sig of r.aiState!.actionSigs!) allSigs.push(sig);
  }
  if (allSigs.length < LOOP_MIN_DOMINANT_COUNT) {
    return { detected: false, roundsSinceProgress: 0, reason: "too few actions" };
  }

  // ponytail: count each unique signature, then ask whether one dominates.
  // "Dominates" = at least N times AND at least 50% of the window. A 3/3
  // strict match passes both; a 3/5 with two other actions also passes
  // (60% ratio, 3 count). This is the case the user hit: A,B,B,C,B,B
  // over the last 5 rounds is B,B,C,B,B = 4/5 = 80% on B → loop.
  const counts = new Map<string, number>();
  for (const s of allSigs) counts.set(s, (counts.get(s) ?? 0) + 1);
  let maxCount = 0;
  for (const c of counts.values()) if (c > maxCount) maxCount = c;
  if (maxCount >= LOOP_MIN_DOMINANT_COUNT && maxCount / allSigs.length >= LOOP_MIN_DOMINANT_RATIO) {
    return {
      detected: true,
      roundsSinceProgress: window.length,
      reason: `same action repeated ${maxCount}/${allSigs.length} times in last ${window.length} rounds`,
    };
  }
  return { detected: false, roundsSinceProgress: 0, reason: "actions varied" };
}

export function classifyIntent(text: string, history?: ReadonlyArray<HistoryRound>): Classification {
  const base = classifyBySignals(text);
  if (!history || history.length === 0) return base;

  const last = history[history.length - 1];
  if (!last) return base;

  // Loop signal is computed on every call, even when the signal is strong,
  // because "fix this bug, 继续, 继续, 继续" with no AI progress is the
  // failure mode the loop detector exists to catch.
  const loop = detectLoop(history);

  const histWeight = historyWeightFor(base, last);
  if (histWeight === 0) {
    return { ...base, loop: loop.detected ? loop : undefined };
  }

  const dist = distributionOf(base);
  const blended: Record<TaskIntent, number> = { fix: 0, verify: 0, research: 0, operate: 0, build: 0 };
  for (const i of INTENTS) {
    blended[i] = dist[i] * (1 - histWeight) + (i === last.intent ? histWeight : 0);
  }
  return { ...ranked(blended), oov: false, loop: loop.detected ? loop : undefined };
}

export function classifyBySignals(text: string): Classification {
  const signals = extractSignals(text);
  if (signals.length === 0) {
    return { ...ranked(WEIGHTS.priors), oov: true };
  }
  // ponytail: priors are a default, not a vote — including them would dilute
  // "研究" (research 0.92) to 0.26 across 8 OOV bigrams.
  const sums: Record<TaskIntent, number> = { fix: 0, verify: 0, research: 0, operate: 0, build: 0 };
  let matched = 0;
  for (const s of signals) {
    const row = WEIGHTS.signals[s];
    if (!row) continue;
    matched++;
    for (const i of INTENTS) sums[i] += row[i];
  }
  if (matched === 0) return { ...ranked(WEIGHTS.priors), oov: true };
  const mean: Record<TaskIntent, number> = { fix: 0, verify: 0, research: 0, operate: 0, build: 0 };
  for (const i of INTENTS) mean[i] = sums[i] / matched;
  return { ...ranked(mean), oov: false };
}

function ranked(p: Record<TaskIntent, number>): Classification {
  // Use the values as-is: the Jev outputs are already calibrated probabilities
  // in [0,1] and a fresh softmax over a near-distribution barely changes
  // argmax but adds a numerical flourish. Sort and return.
  const sorted = INTENTS.map((i) => ({ intent: i, probability: p[i] })).sort((a, b) => b.probability - a.probability);
  const top = sorted[0]!;
  return { intent: top.intent, probability: top.probability, alternatives: sorted.slice(1), oov: false };
}

export function _internalWeights(): Weights { return WEIGHTS; }
