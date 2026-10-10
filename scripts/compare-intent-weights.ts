/**
 * Compare two intent-weights.json files produced by train-intent-weights.ts.
 *
 * D129 §五 (closure): the D124 base (`src/intent-weights.json`, 172 rows /
 * 381 signals) versus the D129 supplement (`scripts/intent-weights-supplemental.json`,
 * 211 rows / 1822 signals). Reports:
 *
 *   - header: rows / signals / trainedAt / priors per side
 *   - signal overlap: how many of the supplement's signals were also in the
 *     base, how many are OOV
 *   - weight shift for shared signals: mean abs delta per intent, max abs
 *     delta per intent, and the 5 largest shifts
 *   - prior shift: the 5 priors (fix/verify/research/operate/build) before
 *     and after
 *
 * Usage: npx --experimental-strip-types scripts/compare-intent-weights.ts
 *        [ <base.json> [ <supplement.json> ] ]
 *
 *   defaults:
 *     base       = src/intent-weights.json
 *     supplement = scripts/intent-weights-supplemental.json
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

interface Weights {
  signals: Record<string, Record<string, number>>;
  counts: Record<string, number>;
  priors: Record<string, number>;
  trainedAt: string;
  rows: number;
}

const INTENTS = ["fix", "verify", "research", "operate", "build"] as const;
type Intent = (typeof INTENTS)[number];

function fmtPriors(p: Record<string, number>): string {
  return INTENTS.map((i) => `${i}:${(p[i] ?? 0).toFixed(3)}`).join("  ");
}

function mean(xs: number[]): number { return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length; }

async function main(): Promise<void> {
  const basePath = resolve(process.argv[2] ?? "src/intent-weights.json");
  const supPath = resolve(process.argv[3] ?? "scripts/intent-weights-supplemental.json");

  const base: Weights = JSON.parse(await readFile(basePath, "utf8"));
  const sup: Weights = JSON.parse(await readFile(supPath, "utf8"));

  console.log("=== D129 §五 closure — D124 base vs D129 supplement ===\n");

  // Header
  console.log("D124 base:");
  console.log(`  path        = ${basePath}`);
  console.log(`  trainedAt   = ${base.trainedAt}`);
  console.log(`  rows        = ${base.rows}`);
  console.log(`  signals     = ${Object.keys(base.signals).length}`);
  console.log(`  priors      = ${fmtPriors(base.priors)}`);

  console.log("\nD129 supplement:");
  console.log(`  path        = ${supPath}`);
  console.log(`  trainedAt   = ${sup.trainedAt}`);
  console.log(`  rows        = ${sup.rows}`);
  console.log(`  signals     = ${Object.keys(sup.signals).length}`);
  console.log(`  priors      = ${fmtPriors(sup.priors)}`);

  // Prior shift
  console.log("\nPriors shift (supplement - base):");
  for (const i of INTENTS) {
    const d = (sup.priors[i] ?? 0) - (base.priors[i] ?? 0);
    const arrow = d > 0 ? "↑" : d < 0 ? "↓" : "=";
    console.log(`  ${i.padEnd(8)} ${(base.priors[i] ?? 0).toFixed(3)} → ${(sup.priors[i] ?? 0).toFixed(3)}  Δ=${d >= 0 ? "+" : ""}${d.toFixed(3)} ${arrow}`);
  }

  // Signal overlap
  const baseKeys = new Set(Object.keys(base.signals));
  const supKeys = Object.keys(sup.signals);
  let shared = 0, oov = 0, onlyBase = 0;
  const sharedSignals: string[] = [];
  for (const s of supKeys) {
    if (baseKeys.has(s)) { shared++; sharedSignals.push(s); }
    else oov++;
  }
  for (const s of baseKeys) if (!(s in sup.signals)) onlyBase++;
  console.log(`\nSignal overlap:`);
  console.log(`  supplement signals: ${supKeys.length}`);
  console.log(`  shared with base:  ${shared} (${(100 * shared / supKeys.length).toFixed(1)}% of supplement)`);
  console.log(`  OOV (new):         ${oov} (${(100 * oov / supKeys.length).toFixed(1)}% of supplement)`);
  console.log(`  only in base:      ${onlyBase}`);

  // Per-intent weight shift on shared signals
  const perIntentAbs: Record<Intent, number[]> = { fix: [], verify: [], research: [], operate: [], build: [] };
  const topShifts: Array<{ signal: string; intent: Intent; base: number; sup: number; abs: number }> = [];
  for (const s of sharedSignals) {
    const bRow = base.signals[s]!;
    const sRow = sup.signals[s]!;
    for (const i of INTENTS) {
      const d = (sRow[i] ?? 0) - (bRow[i] ?? 0);
      perIntentAbs[i].push(Math.abs(d));
      topShifts.push({ signal: s, intent: i, base: bRow[i] ?? 0, sup: sRow[i] ?? 0, abs: Math.abs(d) });
    }
  }
  console.log(`\nPer-intent mean |Δ| on shared signals (n=${shared}):`);
  for (const i of INTENTS) {
    const m = mean(perIntentAbs[i]);
    console.log(`  ${i.padEnd(8)} mean|Δ|=${m.toFixed(3)}  max|Δ|=${(perIntentAbs[i].length ? Math.max(...perIntentAbs[i]) : 0).toFixed(3)}`);
  }

  // Top 10 largest single shifts (any intent)
  topShifts.sort((a, b) => b.abs - a.abs);
  console.log(`\nTop 10 largest single (signal, intent) shifts:`);
  for (const row of topShifts.slice(0, 10)) {
    const dir = row.sup > row.base ? "↑" : "↓";
    console.log(`  ${row.signal.padEnd(10)} ${row.intent.padEnd(8)} ${row.base.toFixed(2)} → ${row.sup.toFixed(2)}  Δ=${(row.sup - row.base).toFixed(2)} ${dir}`);
  }

  // OOV highlights: signals with highest weight in supplement
  const oovSignals = supKeys.filter((s) => !baseKeys.has(s));
  const oovRanked = oovSignals.map((s) => {
    const row = sup.signals[s]!;
    const top = INTENTS.map((i) => ({ intent: i, p: row[i] ?? 0 })).sort((a, b) => b.p - a.p)[0]!;
    return { signal: s, topIntent: top.intent, topP: top.p };
  });
  oovRanked.sort((a, b) => b.topP - a.topP);
  console.log(`\nTop 15 OOV signals (highest single-intent weight in supplement):`);
  for (const o of oovRanked.slice(0, 15)) {
    console.log(`  ${o.signal.padEnd(10)} → ${o.topIntent} ${o.topP.toFixed(2)}`);
  }

  // Naive merge estimate: what would priors look like if we combined?
  const totalRows = base.rows + sup.rows;
  const mergedPriors: Record<Intent, number> = { fix: 0, verify: 0, research: 0, operate: 0, build: 0 };
  for (const i of INTENTS) {
    mergedPriors[i] = (base.priors[i] ?? 0) * base.rows / totalRows + (sup.priors[i] ?? 0) * sup.rows / totalRows;
  }
  console.log(`\nNaive merged priors (${base.rows} + ${sup.rows} = ${totalRows} rows, weighted by row count):`);
  console.log(`  ${fmtPriors(mergedPriors)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
