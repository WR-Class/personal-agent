/**
 * Evaluate the distilled round-quality scorer against Jev's labels, and against
 * D19's mechanical verdict, with a confusion matrix so the disagreement is
 * visible rather than summarised away.
 */
import { readFileSync } from "node:fs";

interface Labeled {
  userPrompt: string; assistantOutput: string; mechanical: string; jev: number;
  steps: number; toolCalls: number; toolErrors: number;
}

const LABELED = "scripts/rounds-labeled.jsonl";
const WEIGHTS = "scripts/round-quality-weights.json";

const rows: Labeled[] = readFileSync(LABELED, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const w = JSON.parse(readFileSync(WEIGHTS, "utf8")) as {
  features: string[]; weight: Record<string, number>; base: number; threshold: number;
};

// Re-import featurize without triggering the script's CLI dispatch.
const mod = await import("./distill-round-quality.ts" as string) as {
  featurize: (r: Labeled) => Record<string, number>;
};

function score(r: Labeled): number {
  const v = mod.featurize(r);
  let s = w.base;
  for (const f of w.features) s += (w.weight[f] ?? 0) * (v[f] ?? 0);
  return Math.max(0, Math.min(1, s));
}

interface Conf { tp: number; fp: number; tn: number; fn: number; }
function confusion(pred: (r: Labeled) => boolean): Conf {
  const c: Conf = { tp: 0, fp: 0, tn: 0, fn: 0 };
  for (const r of rows) {
    const truth = r.jev >= 0.5;
    const p = pred(r);
    if (truth && p) c.tp++; else if (truth && !p) c.fn++; else if (!truth && p) c.fp++; else c.tn++;
  }
  return c;
}
const acc = (c: Conf) => (100 * (c.tp + c.tn) / rows.length).toFixed(1) + "%";
const report = (name: string, c: Conf) =>
  `${name.padEnd(22)} acc=${acc(c).padStart(6)}  tp=${c.tp} fp=${c.fp} tn=${c.tn} fn=${c.fn}`;

const distilled = confusion((r) => score(r) >= w.threshold);
const mechanical = confusion((r) => r.mechanical !== "empty");
// The rules actually shipped in cycle.ts:roundVeto, measured on the same rounds.
const vetoOnly = confusion((r) => {
  const v = mod.featurize(r) as unknown as Record<string, number>;
  return !(v.isEcho || v.outputEmpty || v.noSteps || v.opensWithRefusal);
});
console.log(`rounds: ${rows.length}   Jev-positive: ${rows.filter((r) => r.jev >= 0.5).length}`);
console.log(report("D19 mechanical", mechanical));
console.log(report("shipped roundVeto", vetoOnly));
console.log(report("21-feature scorer", distilled));
console.log(report("mechanical OR distilled", confusion((r) => r.mechanical !== "empty" || score(r) >= w.threshold)));
console.log(report("mechanical AND distilled", confusion((r) => r.mechanical !== "empty" && score(r) >= w.threshold)));

console.log(`\nD19 wrongly calls success (jev<0.5): ${mechanical.fp}`);
const vetoOf = (r: Labeled): boolean => {
  const v = mod.featurize(r) as unknown as Record<string, number>;
  return Boolean(v.isEcho || v.outputEmpty || v.noSteps || v.opensWithRefusal);
};
const fixed = rows.filter((r) => r.mechanical !== "empty" && r.jev < 0.5 && vetoOf(r));
const still = rows.filter((r) => r.mechanical !== "empty" && r.jev < 0.5 && !vetoOf(r));
console.log(`  caught by roundVeto : ${fixed.length}`);
for (const r of fixed) console.log(`    ${JSON.stringify(r.userPrompt.slice(0, 46))}`);
console.log(`  still missed        : ${still.length}`);
for (const r of still) console.log(`    ${JSON.stringify(r.userPrompt.slice(0, 46))}  out=${(r.assistantOutput || "").length}c steps=${r.steps} tools=${r.toolCalls}`);
