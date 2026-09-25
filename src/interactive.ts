import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { SessionStore } from "./session-store.ts";
import { formatBudget } from "./runtime.ts";
import type { AgentRuntime } from "./runtime.ts";
import type { TerminalIO } from "./terminal.ts";
import { assertSafeStateDirectory } from "./security-config.ts";

export const COMMAND_HELP = "/help 帮助 | /new 新会话 | /sessions 列表 | /resume <id> 恢复 | /history 历史 | /compact 压缩上下文（原始消息保留） | /inspect 检查 | /recover 显式补齐中断结果 | /status 状态 | /exit 退出";
export function newSessionId(): string { return `chat-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`; }
export async function listSessions(store: SessionStore): Promise<string[]> {
  const root = assertSafeStateDirectory(store.root);
  if (root !== store.root) throw new Error("会话目录已改变。");
  try {
    const files = await readdir(root, { withFileTypes: true });
    return files.filter(f => f.isFile() && /^[A-Za-z0-9._-]+\.jsonl$/.test(f.name)).map(f => f.name.slice(0,-6)).sort().reverse();
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export interface InteractiveOptions {
  io: TerminalIO;
  store: SessionStore;
  sessionId?: string;
  workspace: string;
  model: string;
  /** One-line summary of the configured ceilings, shown by `/status`. */
  budgetLimits?: string;
  createRuntime(sessionId: string): AgentRuntime;
}
export async function runInteractive(options: InteractiveOptions): Promise<number> {
  const { io, store } = options;
  let runtime = options.createRuntime(options.sessionId ?? newSessionId());
  // Strictly read once before accepting input so corrupt restored sessions fail early.
  try { await runtime.history(); await store.assertReady(runtime.id); }
  catch(error) { io.write(`会话需检查：${(error as Error).message}。可 /inspect 或 /new；原日志保留。\n`); }
  let active: AbortController | undefined;
  const status = () => io.write(`模型: ${options.model}\n工作区: ${options.workspace}\n会话: ${runtime.id}\n${options.budgetLimits ? `上限: ${options.budgetLimits}\n` : ""}`);
  const removeInterrupt = io.onInterrupt(() => {
    if (active) { active.abort(); io.write("\n正在取消本轮；等待执行结束，不再启动后续工具……\n"); }
    else io.close();
  });
  io.write("Personal Agent · 只读工具模式\n");status();io.write(`${COMMAND_HELP}\nCtrl+C：生成中取消本轮，空闲时退出。\n`);
  try {
    while (true) {
      const input = await io.ask("\n你 > ");
      if (input === null) break;
      const text = input.trim();
      if (!text) continue;
      try {
        if (text === "/exit") break;
        if (text === "/help") { io.write(`${COMMAND_HELP}\n`);continue; }
        if (text === "/status") { status();continue; }
        if (text === "/new") { runtime = options.createRuntime(newSessionId()); status();continue; }
        if (text === "/sessions") {
          const ids = await listSessions(store);io.write(ids.length ? ids.join("\n")+"\n" : "尚无已保存会话。\n");continue;
        }
        if (text.startsWith("/resume ")) {
          const id = text.slice(8).trim();
          if (!(await store.exists(id))) throw new Error("会话不存在；用 /sessions 查看可恢复 ID。");
          const candidate = options.createRuntime(id);await candidate.history();
          // Switching is allowed either way: the point is to say so *before* the
          // user types a prompt that send would then refuse. Resuming silently
          // would look like the session is ready when a tool batch is dangling.
          const pending=await store.pendingTools(id);
          runtime = candidate;status();
          if(pending.length)io.write(`注意：该会话有 ${pending.length} 个未完成工具结果。发送前先 /inspect 查看，或用 /recover 显式补齐；不会自动重跑工具。\n`);
          continue;
        }
        if (text === "/inspect" || text.startsWith("/inspect ")) {
          const id=text.slice(8).trim()||runtime.id;
          const report=await store.inspect(id);
          io.write(`事件 ${report.events.length}；结构损坏记录 ${report.problems.length}\n`);
          for(const problem of report.problems)io.write(`行 ${problem.line}: ${problem.detail}\n`);
          if(!report.problems.length)io.write(`待补齐工具结果 ${(await store.pendingTools(id)).length}\n`);
          continue;
        }
        if (text === "/recover" || text.startsWith("/recover ")) {
          const id=text.slice(8).trim()||runtime.id;
          const count=await store.recover(id);io.write(`已追加补齐 ${count} 个工具结果，未执行任何工具；原记录保留。\n`);continue;
        }
        if (text === "/history") {
          const history = await runtime.history();
          for (const message of history) io.write(`${message.role}: ${message.content}\n`);
          if (!history.length) io.write("尚无消息。\n");continue;
        }
        if (text === "/compact") {
          // Only the prompt shrinks: every message stays in the log, so /history
          // and recovery still see the whole conversation.
          const already = await store.compaction(runtime.id);
          // A fresh controller, so Ctrl+C cancels this compaction — reusing the
          // previous turn's controller would abort instantly if that turn had
          // been cancelled.
          active = new AbortController();
          try {
            const result = await runtime.compact(active.signal);
            io.write(`已压缩前 ${result.covers} 条消息（摘要 ${result.summaryLength} 字符）；原始消息全部保留，/history 仍可见。\n`);
            if (already) io.write(`注：本次摘要已在上一次摘要（${already.covers} 条）基础上续写，不是重新总结全部历史。\n`);
          } catch (error) {
            if (active.signal.aborted) io.write("压缩已取消；未写入摘要。\n");
            else throw error;
          } finally { active = undefined; }
          continue;
        }
        if (text.startsWith("/")) { io.write(`未知命令。${COMMAND_HELP}\n`);continue; }
        active = new AbortController();
        try {
          const result = await runtime.send(input, active.signal);
          if (active.signal.aborted) io.write("本轮已取消。\n");
          else {
            // Printed before the answer, and only when the provider exposed one: the
            // trace is what makes the budget line's token count explicable.
            if (result.reasoning !== undefined) io.write(`\n[思考] ${result.reasoning}\n`);
            io.write(`\nAgent > ${result.reply.content}\n${formatBudget(result.budget)}\n`);
          }
          if (result.compactedMessages) io.write(`[上下文已压缩：前 ${result.compactedMessages} 条消息由摘要代表]\n`);
        } catch (error) {
          if (active.signal.aborted && (error === active.signal.reason || (error instanceof Error && error.name === "AbortError"))) {
            io.write("本轮已取消；已写入的用户消息保留。\n");
          } else throw error;
        } finally { active = undefined; }
      } catch (error) { io.write(`错误：${error instanceof Error ? error.message : String(error)}\n`); }
    }
    io.write("已退出；会话保留，可用 /resume 恢复。\n");
    return 0;
  } finally { removeInterrupt(); }
}
