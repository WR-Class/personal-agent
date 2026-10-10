/**
 * Unified round extractor across both session formats in this workspace:
 *
 *   personal-agent  .personal-agent/{chat,desktop-chat}-*.jsonl
 *       { v:1, kind:"message", at, message:{ role, content } }
 *
 *   DSH             <dsh-session-dir>/session.v3.jsonl  (+ per-subagent file)
 *       { type:"user/message",      data:{ content:{type:"text",text}, role, id } }
 *       { type:"assistant/message", data:{ message:{ role, content, id } } }
 *
 * Emits one JSONL row per (user prompt -> assistant output) pair. The label
 * (Jev's `round_success`) is added by label-round-quality.ts in a second pass.
 */
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface Round {
  readonly source: string;
  readonly file: string;
  readonly userPrompt: string;
  readonly assistantOutput: string;
  /** Steps (model turns) this round took, where the format records it. */
  readonly steps: number;
  /** Tool calls observed in this round, where the format records it. */
  readonly toolCalls: number;
  /** Tool results that came back as errors, where the format records it. */
  readonly toolErrors: number;
  /** What D19's evaluateRun would say today, computed the same way. */
  readonly mechanical: "success" | "partial" | "empty";
}

/** Flatten a content value that may be a string or an array of blocks. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === "string") return b;
        if (b && typeof b === "object") {
          const o = b as Record<string, unknown>;
          if (typeof o.text === "string") return o.text;
          if (typeof o.content === "string") return o.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  if (content && typeof content === "object") {
    const o = content as Record<string, unknown>;
    if (typeof o.text === "string") return o.text;
  }
  return "";
}

function isErrorToolResult(text: string): boolean {
  return /^\s*(error|Error|ERROR|failed|refused|denied|blocked)\b/.test(text) ||
    /工具错误|调用失败|被拒绝|权限不足/.test(text);
}

function mechanicalOf(steps: number, toolErrors: number, output: string): Round["mechanical"] {
  if (output.trim().length < 5) return "empty";
  if (steps === 0) return "empty";
  return toolErrors > 0 ? "partial" : "success";
}

/** personal-agent: consecutive assistant messages between two user messages. */
async function extractPersonalAgent(home: string): Promise<Round[]> {
  const files = (await readdir(home)).filter((n) =>
    n.endsWith(".jsonl") && (n.startsWith("chat-") || n.startsWith("desktop-chat-"))
  );
  const rounds: Round[] = [];
  for (const f of files) {
    const text = await readFile(join(home, f), "utf8");
    let user: string | null = null;
    let blocks: string[] = [];
    let steps = 0;
    const flush = () => {
      if (user === null) return;
      const merged = blocks.filter((b) => b.trim().length > 0).join("\n");
      rounds.push({
        source: "personal-agent", file: f, userPrompt: user, assistantOutput: merged,
        steps, toolCalls: 0, toolErrors: 0, mechanical: mechanicalOf(steps, 0, merged),
      });
    };
    for (const line of text.split("\n")) {
      if (!line) continue;
      let j: { kind?: string; message?: { role?: string; content?: unknown } };
      try { j = JSON.parse(line) as typeof j; } catch { continue; }
      if (j.kind !== "message" || !j.message?.role) continue;
      if (j.message.role === "user") {
        flush();
        user = textOf(j.message.content);
        blocks = [];
        steps = 0;
      } else if (j.message.role === "assistant" && user !== null) {
        blocks.push(textOf(j.message.content));
        steps++;
      }
    }
    flush();
  }
  return rounds;
}

/** DSH session.v3: user/message ... assistant/message with tool results between. */
async function extractDshSession(path: string, label: string): Promise<Round[]> {
  const text = await readFile(path, "utf8");
  const rounds: Round[] = [];
  let user: string | null = null;
  let blocks: string[] = [];
  let steps = 0;
  let toolCalls = 0;
  let toolErrors = 0;
  const flush = () => {
    if (user === null) return;
    const merged = blocks.filter((b) => b.trim().length > 0).join("\n");
    rounds.push({
      source: "dsh", file: label, userPrompt: user, assistantOutput: merged,
      steps, toolCalls, toolErrors, mechanical: mechanicalOf(steps, toolErrors, merged),
    });
  };
  for (const line of text.split("\n")) {
    if (!line) continue;
    let j: { type?: string; data?: Record<string, unknown> };
    try { j = JSON.parse(line) as typeof j; } catch { continue; }
    if (j.type === "user/message") {
      flush();
      user = textOf((j.data as { content?: unknown })?.content);
      blocks = [];
      steps = 0;
      toolCalls = 0;
      toolErrors = 0;
    } else if (j.type === "assistant/message" && user !== null) {
      const msg = (j.data as { message?: { content?: unknown } })?.message;
      blocks.push(textOf(msg?.content));
      steps++;
    } else if (j.type === "tool/call" && user !== null) {
      toolCalls++;
    } else if (j.type === "tool/result" && user !== null) {
      const d = j.data as { content?: unknown; isError?: boolean } | undefined;
      const t = textOf(d?.content);
      if (d?.isError === true || isErrorToolResult(t)) toolErrors++;
    }
  }
  flush();
  return rounds;
}

export async function extractAll(): Promise<Round[]> {
  const workspace = "D:/DSHXM/AgentKHD";
  const agentHome = join(workspace, "personal-agent/.personal-agent");
  const all: Round[] = [];
  all.push(...await extractPersonalAgent(agentHome));

  // DSH sessions (main + every subagent), so the corpus is not one model's voice.
  const entries = await readdir(workspace, { withFileTypes: true });
  for (const e of entries) {
    if (!e.isDirectory() || !e.name.startsWith("dsh-session-")) continue;
    const main = join(workspace, e.name, "session.v3.jsonl");
    all.push(...await extractDshSession(main, e.name));
    const subRoot = join(workspace, e.name, "subagents");
    let subs: string[] = [];
    try { subs = await readdir(subRoot); } catch { subs = []; }
    for (const s of subs) {
      all.push(...await extractDshSession(join(subRoot, s, "session.v3.jsonl"), `${e.name}/subagents/${s}`));
    }
  }
  // Drop degenerate rounds: fixture traffic and prompts with no output at all
  // are not decisions the classifier could ever make.
  const kept = all.filter((r) => r.userPrompt.trim().length >= 2 && r.userPrompt.length <= 2000);
  const seen = new Set<string>();
  return kept.filter((r) => {
    const k = `${r.source}:${r.userPrompt.slice(0, 120).replace(/\s+/g, " ")}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("extract-rounds-unified.ts")) {
  const rounds = await extractAll();
  const bySource: Record<string, number> = {};
  const byMech: Record<string, number> = {};
  for (const r of rounds) {
    bySource[r.source] = (bySource[r.source] ?? 0) + 1;
    byMech[r.mechanical] = (byMech[r.mechanical] ?? 0) + 1;
  }
  console.log(`rounds: ${rounds.length}`);
  console.log("by source:", JSON.stringify(bySource));
  console.log("by mechanical:", JSON.stringify(byMech));
  const out = "D:/DSHXM/AgentKHD/personal-agent/scripts/rounds-raw.jsonl";
  await writeFile(out, rounds.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  console.log("wrote", out);
}
