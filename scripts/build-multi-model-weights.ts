/**
 * Build per-model and consensus intent-weights JSONL training sets from a
 * multi-model distillation (the output of `scripts/multi-model-eval.ts`).
 *
 * The single-Jev distillation is one opinion. A multi-model distillation is N
 * opinions, and we want to know:
 *   - **what does training on each provider alone produce?** (per-model weights
 *     — measure how biased that provider's labels are when used solo)
 *   - **what does training on the consensus mean produce?** (multi-mean weights
 *     — the "voting" version that should be the most balanced, by construction)
 *
 * Plus a small spot-check: 5 Chinese prompts run through each weights table, so
 * the human reviewer can see where the per-model weights disagree (D124 ②).
 *
 * The fallback sentinel is `{fix:0.2, verify:0.2, research:0.2, operate:0.2, build:0.2}`
 * (multi-model-eval.ts writes this on a 502/cooldown error). Those rows are
 * excluded from per-model training sets AND from the multi-mean aggregation —
 * an error fallback has no signal, so mixing it in would dilute evidence.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const INTENTS = ["fix", "verify", "research", "operate", "build"] as const;
type Intent = (typeof INTENTS)[number];
type Probs = Record<Intent, number>;

const FALLBACK: Probs = { fix: 0.2, verify: 0.2, research: 0.2, operate: 0.2, build: 0.2 };

function isFallback(p: Probs): boolean {
  for (const i of INTENTS) if (p[i] !== 0.2) return false;
  return true;
}

function meanOrZero(arr: number[]): number {
  if (arr.length === 0) return 0;
  return arr.reduce((s, v) => s + v, 0) / arr.length;
}

function consensusMean(models: Record<string, Probs>): Probs | null {
  const nonFallback: Probs[] = [];
  for (const p of Object.values(models)) if (!isFallback(p)) nonFallback.push(p);
  if (nonFallback.length === 0) return null;
  const out = {} as Probs;
  for (const i of INTENTS) out[i] = meanOrZero(nonFallback.map((p) => p[i]));
  return out;
}

interface MultiRow { text: string; models: Record<string, Probs>; }
interface TrainRow { text: string; gold: string; probs: Probs; source: string; }

async function main() {
  const inPath = resolve(process.argv[2] ?? "scripts/intent-distilled-multi.jsonl");
  const outDir = resolve(process.argv[3] ?? "scripts/multi-weights");
  const raw = await readFile(inPath, "utf8");
  const rows: MultiRow[] = raw.trim().split("\n").map((l) => JSON.parse(l));
  console.error(`Loaded ${rows.length} multi-model rows from ${inPath}`);

  // Per-model training sets: emit only rows where that model produced a
  // non-fallback response. Skipping fallback is the only way to keep the
  // training math from treating an error as a uniform 0.2/0.2/0.2/0.2/0.2.
  const perModelTraining: Record<string, TrainRow[]> = {};
  const consensusTraining: TrainRow[] = [];

  for (const row of rows) {
    for (const [name, p] of Object.entries(row.models)) {
      if (isFallback(p)) continue;
      (perModelTraining[name] ??= []).push({ text: row.text, gold: "?", probs: p, source: name });
    }
    const mean = consensusMean(row.models);
    if (mean !== null) consensusTraining.push({ text: row.text, gold: "?", probs: mean, source: "consensus-mean" });
  }

  await mkdir(outDir, { recursive: true });
  for (const [name, set] of Object.entries(perModelTraining)) {
    const p = resolve(outDir, `intent-distilled-${name}.jsonl`);
    await writeFile(p, set.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
    console.error(`Wrote ${set.length} rows (per-model / ${name}) to ${p}`);
  }
  const consensusPath = resolve(outDir, "intent-distilled-consensus-mean.jsonl");
  await writeFile(consensusPath, consensusTraining.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  console.error(`Wrote ${consensusTraining.length} rows (multi-mean) to ${consensusPath}`);

  // Spot-check set: 5 Chinese prompts picked to span the 5 intents. Hand-curated
  // here rather than scraped from the training set so reviewer sees only natural
  // language, no leakage from the providers' own labels.
  const spotCheck: Record<Intent, string> = {
    fix: "修改这个 bug",
    verify: "测试一下登录流程",
    research: "调研一下 Jev 跟开源 lib 的区别",
    operate: "部署到生产环境",
    build: "实现一个用户登录功能",
  };
  console.error("\n=== D124 ② spot-check (5 prompts × per-source labels) ===");
  for (const [intent, text] of Object.entries(spotCheck)) {
    const row = rows.find((r) => r.text === text);
    console.error(`\nText: "${text}" — human-argmax: ${intent}`);
    if (!row) { console.error("  (no matching row in distillation)"); continue; }
    for (const [name, p] of Object.entries(row.models)) {
      if (isFallback(p)) { console.error(`  ${name.padEnd(10)} (fallback)`); continue; }
      const arg = INTENTS.reduce((best, i) => (p[i] > (p[best] ?? -Infinity) ? i : best), "fix" as Intent);
      console.error(`  ${name.padEnd(10)} -> ${JSON.stringify(p)}  arg=${arg}`);
    }
    const mean = consensusMean(row.models);
    if (mean) {
      const arg = INTENTS.reduce((best, i) => (mean[i] > (mean[best] ?? -Infinity) ? i : best), "fix" as Intent);
      console.error(`  ${"multi-mean".padEnd(10)} -> ${JSON.stringify(mean)}  arg=${arg}`);
    }
  }

  // Summary report
  const src0 = dirname(inPath);
  void src0; // appease linter — kept for debugging
  console.error(`\nNext step: for each of these JSONLs, run train-intent-weights.ts.`);
  console.error(`Suggested output files (place under ${outDir}):`);
  for (const name of Object.keys(perModelTraining)) console.error(`  ${name}    -> ${resolve(outDir, `intent-weights-${name}.json`)}`);
  console.error(`  consensus -> ${resolve(outDir, "intent-weights-consensus-mean.json")}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
