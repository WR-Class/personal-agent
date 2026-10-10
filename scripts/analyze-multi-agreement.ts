/**
 * D131 §一 closure — characterize WHEN models agree vs disagree.
 *
 * Reads `scripts/intent-distilled-multi.jsonl` (211 rows × 3 models × 5 intent
 * probs) and surfaces patterns:
 *   - prompt length distribution in agree vs disagree
 *   - which intent classes most often produce disagreement
 *   - top 30 high-disagreement prompts vs top 30 high-agreement
 *   - per-model bias (which model tends to disagree with the others)
 *
 * Ponytail: read-only analysis on existing data, no LLM calls, no fetches.
 */
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const INTENTS = ["fix", "verify", "research", "operate", "build"] as const;
type Intent = (typeof INTENTS)[number];
type Probs = Record<Intent, number>;
interface MultiRow { text: string; models: Record<string, Probs>; consensus_argmax: string; agree_set: string[]; disagree_set: string[]; }
interface Agreed extends MultiRow { kind: "all" | "partial" | "split" | "single"; }

function argmax(p: Probs): Intent {
  let best: Intent = "fix"; let bestV = -Infinity;
  for (const i of INTENTS) if (p[i] > bestV) { bestV = p[i]; best = i; }
  return best;
}

function spread(p: Probs): number { return Math.max(...INTENTS.map((i) => p[i])) - Math.min(...INTENTS.map((i) => p[i])); }
function entropy(p: Probs): number {
  let h = 0;
  for (const i of INTENTS) if (p[i] > 0) h -= p[i] * Math.log2(p[i]);
  return h;
}

async function main() {
  const inPath = resolve("scripts/intent-distilled-multi.jsonl");
  const raw = await readFile(inPath, "utf8");
  const rows: MultiRow[] = raw.trim().split("\n").map((l) => JSON.parse(l));
  console.error(`Loaded ${rows.length} multi-model rows from ${inPath}`);

  const all: Agreed[] = rows.map((r) => {
    const argmaxes = new Set(Object.values(r.models).map(argmax));
    const kind: Agreed["kind"] =
      argmaxes.size === 1 ? "all" :
      argmaxes.size === 2 ? "partial" :
      argmaxes.size === 3 ? "split" : "single";
    return { ...r, kind };
  });

  const byKind: Record<string, number> = { all: 0, partial: 0, split: 0, single: 0 };
  for (const r of all) byKind[r.kind]++;
  console.log(`\n## Agreement bucket counts\n`);
  for (const [k, n] of Object.entries(byKind)) {
    const pct = ((100 * n) / all.length).toFixed(1);
    console.log(`- ${k.padEnd(10)} ${String(n).padStart(3)} (${pct}%)`);
  }

  console.log(`\n## Prompt length (chars) per bucket\n`);
  console.log(`| bucket | mean | median | min | max |`);
  console.log(`|---|---|---|---|---|`);
  for (const k of ["all", "partial", "split", "single"]) {
    const set = all.filter((r) => r.kind === k);
    if (set.length === 0) { console.log(`| ${k} | 0 | 0 | 0 | 0 |`); continue; }
    const lens = set.map((r) => r.text.length).sort((a, b) => a - b);
    const mean = (lens.reduce((s, n) => s + n, 0) / lens.length).toFixed(1);
    const median = lens[Math.floor(lens.length / 2)] ?? 0;
    console.log(`| ${k} | ${mean} | ${median} | ${lens[0]} | ${lens[lens.length - 1]} |`);
  }

  console.log(`\n## Per-consensus-intent disagreement rate (split / total)\n`);
  console.log(`| intent | total | all-agree | partial | split |`);
  console.log(`|---|---|---|---|---|`);
  for (const intent of INTENTS) {
    const sub = all.filter((r) => r.consensus_argmax === intent);
    if (sub.length === 0) continue;
    const all2 = sub.filter((r) => r.kind === "all").length;
    const partial = sub.filter((r) => r.kind === "partial").length;
    const split = sub.filter((r) => r.kind === "split").length;
    console.log(`| ${intent} | ${sub.length} | ${all2} | ${partial} | ${split} |`);
  }

  const oddOut: Record<string, number> = { jev: 0, claude: 0, grok: 0 };
  for (const r of all) {
    if (r.kind === "all") continue;
    for (const name of r.disagree_set) oddOut[name] = (oddOut[name] ?? 0) + 1;
  }
  console.log(`\n## Per-model "odd-one-out" count (rows where it disagreed from majority)\n`);
  for (const [n, c] of Object.entries(oddOut)) console.log(`- ${n.padEnd(8)} ${c}`);

  const bySpread = [...all].filter((r) => r.kind !== "all").sort((a, b) => {
    const sa = Math.min(...Object.values(a.models).map(spread));
    const sb = Math.min(...Object.values(b.models).map(spread));
    return sa - sb;
  });
  console.log(`\n## Top 15 ambiguous prompts (lowest consensus spread, all models weak)\n`);
  for (const r of bySpread.slice(0, 15)) {
    console.log(`- "${r.text.slice(0, 50)}" consensus=${r.consensus_argmax} models: ` +
      Object.entries(r.models).map(([n, p]) => `${n}=${argmax(p)}@${p[argmax(p)].toFixed(2)}`).join(" "));
  }

  const allAgreeBySpread = all.filter((r) => r.kind === "all").sort((a, b) => {
    const sa = Math.max(...Object.values(a.models).map(spread));
    const sb = Math.max(...Object.values(b.models).map(spread));
    return sb - sa;
  });
  console.log(`\n## Top 15 strong-agreement (all agree AND high prob margin)\n`);
  for (const r of allAgreeBySpread.slice(0, 15)) {
    const intent = r.consensus_argmax;
    const p = r.models.jev[intent] ?? 0;
    console.log(`- "${r.text.slice(0, 50)}" consensus=${intent} jev_prob=${p.toFixed(2)}`);
  }

  const byDissent = all.filter((r) => r.kind === "partial").sort((a, b) => {
    return entropy(a.models.jev) - entropy(b.models.jev);
  });
  console.log(`\n## Top 15 single-model-dissent (2 agree, 1 differs)\n`);
  for (const r of byDissent.slice(0, 15)) {
    const argmaxes = Object.entries(r.models).map(([n, p]) => `${n}=${argmax(p)}@${p[argmax(p)].toFixed(2)}`).join(" ");
    console.log(`- "${r.text.slice(0, 50)}" consensus=${r.consensus_argmax} dissent=${r.disagree_set.join(",")} | ${argmaxes}`);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
