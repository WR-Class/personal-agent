// scripts/evidence-b-replay.ts
// 跨所有 desktop-chat-*.jsonl 跑真 session 回放，输出聚合数据
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { classifyIntent } from "../src/intent-classifier.ts";
import { extractPlanNext } from "../src/history-builder.ts";

const HOME = ".personal-agent";
const files = readdirSync(HOME).filter(f => f.startsWith("desktop-chat-") && f.endsWith(".jsonl"));

console.log("=".repeat(72));
console.log(`桌面 chat 真 session 聚合`);
console.log("=".repeat(72));
console.log(`找到 ${files.length} 个 desktop-chat jsonl 文件\n`);

// 工具调用名到 intent 的启发式
function guessIntentFromTools(tools: string[]): string {
  if (tools.some(t => t.startsWith("edit_file") || t.startsWith("patch_file"))) return "build";
  if (tools.some(t => t.startsWith("read_file") || t.startsWith("list_directory"))) return "research";
  if (tools.some(t => t.startsWith("run_command"))) return "operate";
  return "build";
}

// 工具调用名 → 简化显示
function shortTool(t: string): string {
  return t.replace(/^\w+_/, "").replace(/\(.*/, "").slice(0, 12);
}

interface RunSummary {
  file: string;
  runId: string;
  userText: string;
  tools: string[];
  toolSummary: string[];
  toolCount: number;
  planNext: string | null;
  hasUpdateTaskState: boolean;
  assistantMsgCount: number;
}

interface ClassOut {
  intent: string;
  probability: number;
  oov: boolean;
  loop: boolean;
  loopReason: string;
  alts: string;
  goldIntent: string;
  match: boolean;
  matchUnderThreshold: boolean;  // 概率 < 0.5
}

const allRuns: RunSummary[] = [];

for (const file of files) {
  const path = join(HOME, file);
  const stat = statSync(path);
  if (stat.size < 100) continue;  // 跳过空文件
  const lines = readFileSync(path, "utf8").split("\n").filter(l => l.length > 0);

  // 按 runId 分组 user message + assistant messages
  const runs = new Map<string, { user: any | null; assistants: any[] }>();
  for (const line of lines) {
    try {
      const ev = JSON.parse(line);
      if (ev.kind !== "message") continue;
      if (!runs.has(ev.runId)) runs.set(ev.runId, { user: null, assistants: [] });
      const r = runs.get(ev.runId)!;
      if (ev.message?.role === "user") {
        r.user = { step: ev.step, text: ev.message.content };
      } else if (ev.message?.role === "assistant") {
        r.assistants.push({
          step: ev.step,
          text: ev.message.content ?? "",
          toolCalls: (ev.message.toolCalls ?? []).map((tc: any) => `${tc.name}(${(tc.arguments ?? "").slice(0, 60)})`),
        });
      }
    } catch {}
  }

  for (const [runId, run] of runs) {
    if (!run.user) continue;
    const tools: string[] = [];
    for (const a of run.assistants) for (const t of a.toolCalls) tools.push(t);
    const toolSummary = tools.map(shortTool);
    const lastAssistant = run.assistants[run.assistants.length - 1];
    const planNext = lastAssistant ? extractPlanNext(lastAssistant.text) : null;
    const hasUpdateTaskState = tools.some(t => t.startsWith("update_task_state"));

    allRuns.push({
      file,
      runId,
      userText: run.user.text,
      tools,
      toolSummary,
      toolCount: tools.length,
      planNext,
      hasUpdateTaskState,
      assistantMsgCount: run.assistants.length,
    });
  }
}

console.log(`聚合: ${allRuns.length} 轮（user message 数量）\n`);

// 按文件分组输出
let totalMatched = 0;
let totalLowConf = 0;
let totalPlanNextHit = 0;
let totalLoopDetected = 0;
const byFile = new Map<string, ClassOut[]>();

for (const run of allRuns) {
  // 构造 history（用上一轮的工具调用当 aiState 简化）
  const idx = allRuns.indexOf(run);
  const history: any[] = [];
  for (let i = Math.max(0, idx - 4); i < idx; i++) {
    const prev = allRuns[i]!;
    if (prev.file !== run.file) continue;
    history.push({
      intent: guessIntentFromTools(prev.tools),
      prompt: prev.userText,
      aiState: {
        didWhat: prev.tools.map(shortTool).slice(0, 3).join(", "),
        completed: true,
        planNext: prev.planNext,
        actionSigs: prev.tools.map(t => {
          const m = t.match(/^(\w+)\(/);
          return m ? `${m[1]}|` : t;
        }),
      },
    });
  }

  // 跑 classifier
  const c = classifyIntent(run.userText, history);
  const goldIntent = guessIntentFromTools(run.tools);
  const match = c.intent === goldIntent;
  if (match) totalMatched++;
  if (c.probability < 0.5) totalLowConf++;

  // planNext 检查
  if (run.planNext) totalPlanNextHit++;

  // loop 检查
  if (c.loop?.detected) totalLoopDetected++;

  const out: ClassOut = {
    intent: c.intent,
    probability: c.probability,
    oov: c.oov,
    loop: c.loop?.detected ?? false,
    loopReason: c.loop?.reason ?? "n/a",
    alts: c.alternatives.map(a => `${a.intent}:${a.probability.toFixed(2)}`).join(", "),
    goldIntent,
    match,
    matchUnderThreshold: c.probability < 0.5,
  };

  if (!byFile.has(run.file)) byFile.set(run.file, []);
  byFile.get(run.file)!.push(out);
}

// 输出每个文件
for (const [file, outs] of byFile) {
  const matched = outs.filter(o => o.match).length;
  const lowConf = outs.filter(o => o.matchUnderThreshold).length;
  console.log(`\n┌─ ${file} (${outs.length} 轮)`);
  console.log(`│  准确率 (classifier 路由 = gold intent): ${matched}/${outs.length} = ${(100*matched/outs.length).toFixed(1)}%`);
  console.log(`│  低置信度 (prob<0.5): ${lowConf}/${outs.length} = ${(100*lowConf/outs.length).toFixed(1)}%`);
  for (let i = 0; i < outs.length; i++) {
    const o = outs[i]!;
    const r = allRuns.find(r => r.file === file && byFile.get(file)!.indexOf(o) === i);
    if (!r) continue;
    const mark = o.match ? "✓" : "✗";
    console.log(`│  [${mark}] gold=${o.goldIntent.padEnd(8)} v5=${o.intent.padEnd(8)} (p=${o.probability.toFixed(2)}, oov=${o.oov}) loop=${o.loop ? "Y" : "N"} | "${r.userText.slice(0, 30)}${r.userText.length > 30 ? '…' : ''}"`);
  }
}

console.log("\n" + "=".repeat(72));
console.log("【总聚合】");
console.log("=".repeat(72));
console.log(`总轮数:       ${allRuns.length}`);
console.log(`路由准确率:   ${totalMatched}/${allRuns.length} = ${(100*totalMatched/allRuns.length).toFixed(1)}% (classifier intent = gold tools-derived intent)`);
console.log(`低置信度:     ${totalLowConf}/${allRuns.length} = ${(100*totalLowConf/allRuns.length).toFixed(1)}% (prob < 0.5)`);
console.log(`planNext 命中: ${totalPlanNextHit}/${allRuns.length} = ${(100*totalPlanNextHit/allRuns.length).toFixed(1)}%`);
console.log(`loop 触发:     ${totalLoopDetected}/${allRuns.length}`);
