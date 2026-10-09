// scripts/evidence-a-classifier.ts
// 测 v5 features 的真实效果：baseline (无 history) vs v5 (有 history) vs v5 (无 history, 对照)
import { readFileSync } from "node:fs";
import { classifyIntent, classifyBySignals } from "../src/intent-classifier.ts";

const prompts = JSON.parse(readFileSync("scripts/intent-prompts.json", "utf8")) as Array<{ intent: string; text: string }>;
const total = prompts.length;
function short(t: string, n=14): string { return t.length>n ? t.slice(0,n)+"…" : t; }

// 三组对比：
// A. baseline (classifyBySignals, no history) - 纯 signals
// B. v5 no history (classifyIntent, history=[]) - 应该 = A
// C. v5 with history (classifyIntent, history=[{intent: gold, ...}]) - 测 v5 特性

let A = 0, B = 0, C = 0;
let shortA = 0, shortB = 0, shortC = 0;
const oovSet: Array<{text: string; gold: string}> = [];
const byIntent: Record<string, {a:number; b:number; c:number; total:number}> = {
  fix:{a:0,b:0,c:0,total:0}, verify:{a:0,b:0,c:0,total:0}, research:{a:0,b:0,c:0,total:0},
  operate:{a:0,b:0,c:0,total:0}, build:{a:0,b:0,c:0,total:0},
};

const cHelps: Array<{text:string; gold:string; base:string; v5:string}> = [];
const cHurts: Array<{text:string; gold:string; base:string; v5:string}> = [];

for (const row of prompts) {
  // A: 纯 signals
  const a = classifyBySignals(row.text);
  if (a.intent === row.intent) { A++; byIntent[row.intent].a++; }
  byIntent[row.intent].total++;

  // B: v5 无 history
  const b = classifyIntent(row.text, []);
  if (b.intent === row.intent) { B++; byIntent[row.intent].b++; }

  // C: v5 有 history（假设上轮是同一个 intent）
  const history = [{ intent: row.intent as any, prompt: "上轮" }];
  const c = classifyIntent(row.text, history);
  if (c.intent === row.intent) { C++; byIntent[row.intent].c++; }

  if (a.oov) oovSet.push({text: row.text, gold: row.intent});

  // 短 prompt（≤3 字符）
  if (row.text.length <= 3) {
    if (a.intent === row.intent) shortA++;
    if (b.intent === row.intent) shortB++;
    if (c.intent === row.intent) shortC++;
  }

  if (a.intent !== row.intent && c.intent === row.intent) {
    cHelps.push({text: row.text, gold: row.intent, base: a.intent, v5: c.intent});
  }
  if (a.intent === row.intent && c.intent !== row.intent) {
    cHurts.push({text: row.text, gold: row.intent, base: a.intent, v5: c.intent});
  }
}

console.log("=".repeat(72));
console.log(`D124 prompt set: ${total} 条`);
console.log("=".repeat(72));
console.log("");
console.log("【三组对比】");
console.log(`  A. baseline (classifyBySignals, no hist):  ${A}/${total} = ${(100*A/total).toFixed(1)}%`);
console.log(`  B. v5 no history (对照，应该≈A):           ${B}/${total} = ${(100*B/total).toFixed(1)}%`);
console.log(`  C. v5 with history (上轮=gold intent):     ${C}/${total} = ${(100*C/total).toFixed(1)}%`);
console.log(`     C-A 收益: ${(C-A >= 0 ? "+" : "")}${C-A} 条`);
console.log("");
console.log("【按意图分 (A / B / C)】");
for (const k of Object.keys(byIntent)) {
  const x = byIntent[k]!;
  if (x.total === 0) continue;
  console.log(`  ${k.padEnd(8)}: ${x.a}/${x.total} / ${x.b}/${x.total} / ${x.c}/${x.total}  (${(100*x.a/x.total).toFixed(0)}% / ${(100*x.b/x.total).toFixed(0)}% / ${(100*x.c/x.total).toFixed(0)}%)`);
}
console.log("");
console.log(`【短 prompt（≤3 字符，共 ${shortA+shortB+shortC ? 0 : 0}）】 — 数据按上面组分别计`);
console.log(`  A (baseline) 短 prompt 命中: ${shortA}`);
console.log(`  B (v5 no hist) 短 prompt 命中: ${shortB}`);
console.log(`  C (v5 with hist) 短 prompt 命中: ${shortC}`);
console.log("");
console.log(`【OOV prompt 数量】: ${oovSet.length} 条 (A 走 priors / B 走 priors / C 走 history 混合)`);
console.log("");
console.log(`【C 修了但 A 错（v5 history 帮了）】共 ${cHelps.length} 条`);
for (const h of cHelps.slice(0,15)) console.log(`  "${short(h.text)}" gold=${h.gold} base=${h.base} v5=${h.v5}`);
if (cHelps.length > 15) console.log(`  ... 还有 ${cHelps.length - 15} 条`);
console.log("");
console.log(`【C 改了但 A 对（v5 history 害了）】共 ${cHurts.length} 条`);
for (const h of cHurts.slice(0,15)) console.log(`  "${short(h.text)}" gold=${h.gold} base=${h.base} v5=${h.v5}`);
if (cHurts.length > 15) console.log(`  ... 还有 ${cHurts.length - 15} 条`);
