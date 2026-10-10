/**
 * Train: aggregate the distilled Jev JSONL into a per-signal probability table.
 *
 * **D130 fix (2026-10-09)**: the previous version counted every `(signal, row)`
 * pair as an independent observation, so a 30-bigram Chinese prompt contributed
 * the row's prob vector to all 30 of its bigrams. A single "build" prompt of
 * 60 characters produced 30 "build" bigrams, each at confidence 0.98 — even
 * though the row was 1 observation. The new version treats the row as 1
 * observation and divides its prob vector equally across the row's signals,
 * so the total evidence per row is preserved but no single bigram can be
 * inflated by the row's length.
 *
 * For every signal s that appears in any training prompt, store the mean
 * Jev probability across all prompts containing s, for each intent. At
 * inference we average those vectors over the prompt's signals and softmax.
 *
 * Usage: npx --experimental-strip-types scripts/train-intent-weights.ts
 *        [ <in.jsonl> [ <out.json> ] ]
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { extractSignals } from "../src/taskspec.ts";

const INTENTS = ["fix", "verify", "research", "operate", "build"] as const;
type Intent = (typeof INTENTS)[number];

export interface Row { text: string; gold: string; probs: Record<string, number>; }
export interface Weights {
  signals: Record<string, Record<Intent, number>>;
  counts: Record<string, number>;
  priors: Record<Intent, number>;
  trainedAt: string;
  rows: number;
}

/**
 * Aggregate `rows` into a `Weights` table.
 *
 * Each row contributes its `probs` once to the priors (1 row = 1 observation
 * of "what intent is this prompt"). For per-signal weights, the row's probs
 * are divided equally across the signals the row produced (D130): so a row
 * with 30 bigrams contributes 1/30 of its evidence to each bigram, and the
 * total evidence the row adds across all its signals is 1.0. That keeps a
 * long prompt from inflating the weights of the bigrams it happens to span.
 */
export function train(rows: ReadonlyArray<Row>, now: string = new Date().toISOString()): Weights {
  const sums: Record<string, Record<Intent, number>> = {};
  const counts: Record<string, number> = {};
  const priors: Record<Intent, number> = { fix: 0, verify: 0, research: 0, operate: 0, build: 0 };

  for (const row of rows) {
    for (const i of INTENTS) priors[i] += row.probs[i] ?? 0;
    // D130: 1 row = 1 observation. Spread its evidence across the row's signals.
    const signals = extractSignals(row.text);
    if (signals.length === 0) continue; // a row with no signals contributes only to priors
    const share = 1 / signals.length;
    for (const sig of signals) {
      counts[sig] = (counts[sig] ?? 0) + 1;
      const s = (sums[sig] ??= { fix: 0, verify: 0, research: 0, operate: 0, build: 0 });
      for (const i of INTENTS) s[i] += (row.probs[i] ?? 0) * share;
    }
  }

  const total = rows.length;
  for (const i of INTENTS) priors[i] /= total === 0 ? 1 : total;

  const signals: Record<string, Record<Intent, number>> = {};
  for (const [sig, sum] of Object.entries(sums)) {
    const c = counts[sig] ?? 1;
    signals[sig] = { fix: sum.fix / c, verify: sum.verify / c, research: sum.research / c, operate: sum.operate / c, build: sum.build / c };
  }

  return { signals, counts, priors, trainedAt: now, rows: total };
}

async function main() {
  const inPath = resolve(process.argv[2] ?? "scripts/intent-distilled.jsonl");
  const outPath = resolve(process.argv[3] ?? "src/intent-weights.json");
  const raw = (await readFile(inPath, "utf8")).replace(/\r\n?/g, "\n");
  const rows: Row[] = raw.trim().split("\n").map((l) => JSON.parse(l));
  const weights = train(rows);
  await writeFile(outPath, JSON.stringify(weights, null, 2) + "\n", "utf8");
  console.error(`Trained on ${weights.rows} rows; ${Object.keys(weights.signals).length} signals; wrote ${outPath}`);
  // Print a few interesting signals
  for (const s of ["运维", "服务器", "fix", "测试", "build", "deploy", "实现", "调研", "bug"]) {
    if (weights.signals[s]) console.error(`  ${s.padEnd(8)} -> ${JSON.stringify(weights.signals[s])}`);
  }
}

// Run `main` only when this file is the CLI entry, not when it's imported as
// a library by a test. Without this guard, importing the file from a test
// would silently overwrite `src/intent-weights.json` on every test run.
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
