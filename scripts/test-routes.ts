/**
 * Quick check — what does the merged weights classifier say for each test case?
 */
import { classifyIntent } from "../src/intent-classifier.ts";
const cases = [
  ["修这个 bug", "fix"],
  ["继续", "?"],
  ["好", "?"],
  ["OK", "?"],
  ["修修修", "?"],
  ["xyzzy plugh foobar", "?"],
  ["调研 Jev 是什么", "research"],
  ["部署到生产", "operate"],
  ["加登录功能", "build"],
];
for (const [text, expected] of cases) {
  const r = classifyIntent(text);
  console.log(`"${text}" -> ${r.intent} ${r.probability.toFixed(3)} oov=${r.oov}`);
}

console.log("\n=== v5: planNext 提升 (OOV 0.6 → 0.7) ===");
const withoutPlan = [{ intent: "fix" as const, prompt: "修登录 bug" }];
const withPlan = [{
  intent: "fix" as const,
  prompt: "修登录 bug",
  aiState: { didWhat: "修了 1/3", completed: false, planNext: "应用 fix-2.patch" },
}];
for (const text of ["继续", "好", "OK", "嗯", "修修修"]) {
  const a = classifyIntent(text, withoutPlan);
  const b = classifyIntent(text, withPlan);
  console.log(`"${text}" | 无 plan: ${a.intent} ${a.probability.toFixed(3)} | 有 plan: ${b.intent} ${b.probability.toFixed(3)} (差 +${(b.probability - a.probability).toFixed(3)})`);
}

console.log("\n=== v5: loop 检测 ===");
const state = { didWhat: "修登录 bug 中", completed: false };
const loopHist = [
  { intent: "fix" as const, prompt: "修登录", aiState: state },
  { intent: "fix" as const, prompt: "继续", aiState: state },
  { intent: "fix" as const, prompt: "继续", aiState: state },
  { intent: "fix" as const, prompt: "继续", aiState: state },
];
const r = classifyIntent("继续", loopHist);
console.log(`"继续" (loop hist) -> ${r.intent} ${r.probability.toFixed(3)} loop=${JSON.stringify(r.loop)}`);

const progressHist = [
  { intent: "fix" as const, prompt: "修登录", aiState: { didWhat: "修了 1/3", completed: false } },
  { intent: "fix" as const, prompt: "继续", aiState: { didWhat: "修了 2/3", completed: false } },
  { intent: "fix" as const, prompt: "继续", aiState: { didWhat: "修了 3/3", completed: true } },
  { intent: "fix" as const, prompt: "继续", aiState: { didWhat: "部署了", completed: true } },
];
const r2 = classifyIntent("继续", progressHist);
console.log(`"继续" (progress hist) -> ${r2.intent} ${r2.probability.toFixed(3)} loop=${JSON.stringify(r2.loop)}`);
for (const [text, expected] of cases) {
  const r = classifyIntent(text);
  const ok = r.intent === expected ? "✓" : "✗";
  console.log(`${ok} "${text}" expected=${expected} got=${r.intent} prob=${r.probability.toFixed(3)} oov=${r.oov}`);
}
