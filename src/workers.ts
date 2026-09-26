/**
 * Bounded read-only swarm workers (D13).
 *
 * Mechanism borrowed from dsh-lab's dsh-swarm: isolation is enforced at the
 * tool layer — a worker's registry contains only `read_file`, so write tools
 * (and this dispatch tool) are structurally absent, never merely discouraged.
 * Decide and execute stay separate: the model proposes subtasks, the operator
 * approves the exact manifest once, execution runs afterwards.
 */
import { randomUUID } from "node:crypto";

import type { ModelAdapter } from "./types.ts";
import type { SessionStore } from "./session-store.ts";
import { AgentRuntime } from "./runtime.ts";
import { ToolRegistry, createReadFileTool, approveExact, denied } from "./tools.ts";
import type { Tool, ToolContext, ToolResult } from "./tools.ts";

/** Hard ceiling per dispatch. More subtasks are refused before any approval. */
export const MAX_WORKERS = 2;

/** The only tool a worker may call. Adding a tool here widens every worker. */
export function workerTools(): ToolRegistry {
  return new ToolRegistry([createReadFileTool()]);
}

export interface DispatchWorkersOptions {
  adapter: ModelAdapter;
  store: SessionStore;
  workspaceRoot: string;
  home: string;
}

function result(name: string, message: string, isError = false): ToolResult {
  return { content: message, ...(isError ? { isError: true } : {}) };
}

/** Dispatch up to {@link MAX_WORKERS} read-only workers, one exact approval. */
export function createDispatchWorkersTool(options: DispatchWorkersOptions): Tool {
  return {
    name: "dispatch_workers",
    description: `Run 1 to ${MAX_WORKERS} read-only worker agents, each on its own subtask with an independent context. Each worker returns its final answer.`,
    parameters: {
      type: "object",
      properties: {
        subtasks: { type: "array", items: { type: "string" }, description: "One self-contained subtask prompt per worker." },
      },
      required: ["subtasks"],
    },
    readOnly: false,
    async execute(args, context: ToolContext): Promise<ToolResult> {
      const subtasks = args.subtasks;
      if (!Array.isArray(subtasks) || subtasks.length === 0 || subtasks.length > MAX_WORKERS) {
        return result("dispatch_workers", `dispatch_workers: subtasks must contain 1 to ${MAX_WORKERS} items`, true);
      }
      const prompts: string[] = [];
      for (const subtask of subtasks) {
        if (typeof subtask !== "string" || subtask.trim() === "") return result("dispatch_workers", "dispatch_workers: every subtask must be a non-empty string", true);
        prompts.push(subtask.trim());
      }
      const manifest = prompts.map((prompt, index) => `${index + 1}. ${prompt}`).join("\n");
      const denial = await approveExact("dispatch_workers", args, `分派 ${prompts.length} 个只读 worker？\n${manifest}\n本次批准 2 分钟内有效，只对这份清单有效。`, context);
      if (denial) return denied("dispatch_workers", denial, context);

      const lines: string[] = [];
      let failures = 0;
      for (const [index, prompt] of prompts.entries()) {
        // A worker is a fresh runtime with its own session: independent context,
        // own session log, own TaskSpec per send (D12). Its registry is
        // workerTools(), so it cannot write and cannot dispatch again.
        const worker = new AgentRuntime({
          adapter: options.adapter,
          store: options.store,
          sessionId: `worker-${randomUUID()}`,
          workspaceRoot: options.workspaceRoot,
          home: options.home,
          tools: workerTools(),
        });
        try {
          const sent = await worker.send(prompt, context.signal);
          lines.push(`${index + 1}. ok: ${sent.reply.content}`);
        } catch (error) {
          failures += 1;
          lines.push(`${index + 1}. failed: ${(error as Error).message}`);
        }
      }
      return result("dispatch_workers", `dispatched ${prompts.length} worker(s)\n${lines.join("\n")}`, failures > 0);
    },
  };
}
