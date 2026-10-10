/**
 * D124 ② spot-check: classify a set of Chinese prompts through multiple
 * `intent-weights.json` files and emit a side-by-side table.
 *
 * The hand-written prompts below are NOT in the distillation set (D129 supplement
 * has only real user history). They're chosen so the human reviewer sees whether
 * each weights table matches their own judgement.
 *
 * Usage: npx --experimental-strip-types scripts/spot-check.ts
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { extractSignals } from "../src/taskspec.ts";

const INTENTS = ["fix", "verify", "research", "operate", "build"] as const;
type Intent = (typeof INTENTS)[number];

interface Weights {
  signals: Record<string, Record<Intent, number>>;
  counts: Record<string, number>;
  priors: Record<Intent, number>;
  trainedAt: string;
  rows: number;
}

interface Classification {
  intent: Intent;
  probability: number;
  oov: boolean;
  matchedCount: number;
}

function classifyWith(text: string, W: Weights): Classification {
  const signals = extractSignals(text);
  if (signals.length === 0) return { intent: "fix", probability: W.priors.fix, oov: true, matchedCount: 0 };
  const sums: Record<Intent, number> = { fix: 0, verify: 0, research: 0, operate: 0, build: 0 };
  let matched = 0;
  for (const s of signals) {
    const row = W.signals[s];
    if (!row) continue;
    matched++;
    for (const i of INTENTS) sums[i] += row[i];
  }
  if (matched === 0) {
    let best: Intent = "fix"; let bestV = -Infinity;
    for (const i of INTENTS) if (W.priors[i] > bestV) { bestV = W.priors[i]; best = i; }
    return { intent: best, probability: W.priors[best], oov: true, matchedCount: 0 };
  }
  const mean: Record<Intent, number> = { fix: 0, verify: 0, research: 0, operate: 0, build: 0 };
  for (const i of INTENTS) mean[i] = sums[i] / matched;
  let top: Intent = "fix"; let topV = -Infinity;
  for (const i of INTENTS) if (mean[i] > topV) { topV = mean[i]; top = i; }
  return { intent: top, probability: mean[top], oov: false, matchedCount: matched };
}

const SPOT = [
  { human: "fix",      text: "修改这个 bug" },
  { human: "verify",   text: "测试一下登录流程" },
  { human: "research", text: "调研一下 Jev 跟开源 lib 的区别" },
  { human: "operate",  text: "部署到生产环境" },
  { human: "build",    text: "实现一个用户登录功能" },
];

const WEIGHTS_FILES = [
  { label: "merged (D130)",       path: "scripts/intent-weights-merged.json" },
  { label: "jev-only (D132)",     path: "scripts/multi-weights/intent-weights-jev.json" },
  { label: "consensus (D132)",    path: "scripts/multi-weights/intent-weights-consensus-mean.json" },
  { label: "claude (D132)",       path: "scripts/multi-weights/intent-weights-claude.json" },
  { label: "src/intent-weights.json (D124 base, 生产)", path: "src/intent-weights.json" },
];

async function main() {
  const all: { label: string; weights: Weights }[] = [];
  for (const f of WEIGHTS_FILES) {
    const w = JSON.parse(await readFile(resolve(f.path), "utf8")) as Weights;
    all.push({ label: f.label, weights: w });
  }

  console.log(`# D124 ② spot-check — 5 Chinese prompts × ${all.length} weights tables\n\nHuman-argmax is what a Chinese-speaking reviewer would pick. Numbers shown are the argmax prob in [0,1]; the row is highlighted only by what the model chose, not the prob value.\n\n`);

  for (const s of SPOT) {
    console.log(`## Text: "${s.text}" — human-argmax: **${s.human}**\n`);
    console.log(`| weights | argmax | prob | matched signals | oov |`);
    console.log(`|---|---|---|---|---|`);
    for (const f of all) {
      const c = classifyWith(s.text, f.weights);
      const oovTag = c.oov ? "yes" : "no";
      const humanMatch = c.intent === s.human ? "✓" : "✗";
      console.log(`| ${f.label} | ${humanMatch} ${c.intent} | ${c.probability.toFixed(3)} | ${c.matchedCount} | ${oovTag} |`);
    }
    console.log();
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
