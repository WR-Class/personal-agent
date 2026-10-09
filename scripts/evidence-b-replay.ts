// scripts/evidence-b-replay.ts
// 真实 session 回放 — 跑 desktop-chat-edf573e3 看 classifier 实际产出
import { readFileSync } from "node:fs";
import { classifyIntent } from "../src/intent-classifier.ts";
import { extractPlanNext } from "../src/history-builder.ts";

const FILE = ".personal-agent/desktop-chat-edf573e3-d4c4-4d61-b49a-d0117ac6bac6.jsonl";
const lines = readFileSync(FILE, "utf8").split("\n").filter(l => l.length > 0);

// 解析：找出 user message + assistant tool calls
const userMsgs: Array<{ step: number; runId: string; text: string; afterAssistantMsgs: number[] }> = [];
const assistantMsgs: Array<{ step: number; runId: string; text: string; toolCalls: string[] }> = [];

for (const line of lines) {
  try {
    const ev = JSON.parse(line);
    if (ev.kind === "message" && ev.message?.role === "user") {
      const idx = userMsgs.length;
      userMsgs.push({ step: ev.step, runId: ev.runId, text: ev.message.content, afterAssistantMsgs: [] });
      // 标记上一个 user message 的"已观察助手消息" 结束
      if (idx > 0) userMsgs[idx-1].afterAssistantMsgs.push(ev.step);
    } else if (ev.kind === "message" && ev.message?.role === "assistant") {
      const tcs = (ev.message.toolCalls ?? []).map((tc: any) => `${tc.name}(${(tc.arguments ?? "").slice(0,30)})`);
      assistantMsgs.push({ step: ev.step, runId: ev.runId, text: ev.message.content ?? "", toolCalls: tcs });
    }
  } catch {}
}

console.log("=".repeat(72));
console.log(`真实 session 回放: ${FILE}`);
console.log("=".repeat(72));
console.log(`user 消息: ${userMsgs.length} 条, assistant 消息: ${assistantMsgs.length} 条`);
console.log("");

// 按 runId 分组（一个 run = 一轮 = 一个 user message + 后续 assistant 消息）
const runs = new Map<string, { user: any; assistants: any[] }>();
for (const u of userMsgs) {
  runs.set(u.runId, { user: u, assistants: [] });
}
for (const a of assistantMsgs) {
  const r = runs.get(a.runId);
  if (r) r.assistants.push(a);
}

let runIdx = 0;
for (const [runId, run] of runs) {
  runIdx++;
  console.log(`\n【第 ${runIdx} 轮】 runId=${runId.slice(0,8)}...`);
  console.log(`  user: "${run.user.text.slice(0, 50)}${run.user.text.length > 50 ? '…' : ''}"`);
  console.log(`  助手消息: ${run.assistants.length} 条`);

  // 列出工具调用
  const allTools: string[] = [];
  for (const a of run.assistants) {
    for (const t of a.toolCalls) allTools.push(t);
  }
  if (allTools.length > 0) {
    console.log(`  工具调用 (${allTools.length} 次):`);
    for (const t of allTools.slice(0, 10)) console.log(`    - ${t}`);
    if (allTools.length > 10) console.log(`    ... 还有 ${allTools.length - 10} 次`);
  }

  // 最后一条 assistant 文本 → 提取 planNext
  const lastAssistant = run.assistants[run.assistants.length - 1];
  if (lastAssistant) {
    const planNext = extractPlanNext(lastAssistant.text);
    if (planNext) console.log(`  planNext 提取: "${planNext}"`);
    else console.log(`  planNext 提取: (无匹配)`);
  }

  // 构造 history
  const history: any[] = [];
  for (let i = 0; i < runIdx - 1; i++) {
    const prevRun = [...runs.values()][i];
    if (prevRun) {
      // 给每条上轮一个 aiState 占位（不知道真实 intent，根据上轮文本猜）
      history.push({
        intent: "build",  // 简化：都用 build 演示
        prompt: prevRun.user.text,
        aiState: {
          didWhat: prevRun.assistants.map(a => a.toolCalls.join("; ")).join("; ").slice(0, 50) || "无工具调用",
          completed: true,
          planNext: extractPlanNext(prevRun.assistants[prevRun.assistants.length-1]?.text ?? ""),
        },
      });
    }
  }

  // classifier 输出
  const c = classifyIntent(run.user.text, history);
  console.log(`  ----`);
  console.log(`  classifier 路由:`);
  console.log(`    intent:    ${c.intent} (probability=${c.probability.toFixed(3)})`);
  console.log(`    oov:       ${c.oov}`);
  console.log(`    loop:      ${c.loop?.detected ?? false} (${c.loop?.reason ?? "n/a"})`);
  console.log(`    alts:      ${c.alternatives.map(a => `${a.intent}:${a.probability.toFixed(2)}`).join(", ")}`);
}
