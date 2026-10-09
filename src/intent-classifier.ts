/**
 * Intent classifier distilled from Jev (D124).
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
 * History-aware routing (D138-D142) was removed: 98 real-session rounds
 * showed planNext extraction hit 0/98, the loop signal was never read
 * downstream, and the history-blend routing was 65% wrong on real data
 * (polluting the swarm's gene reliability with classifier errors). The
 * classifier now does exactly one thing: text → intent. The LLM does
 * the rest.
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

export interface Classification {
  intent: TaskIntent;
  probability: number;
  alternatives: { intent: TaskIntent; probability: number }[];
  oov: boolean;
}

export function classifyIntent(text: string): Classification {
  return classifyBySignals(text);
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
