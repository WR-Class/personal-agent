import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import { createDispatchWorkersTool, workerTools } from "../src/workers.ts";
import { ToolRegistry, createReadFileTool } from "../src/tools.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { SessionStore } from "../src/session-store.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import type { ToolCall } from "../src/types.ts";
import { createTestFixture } from "./fixtures.ts";

let fixture: Awaited<ReturnType<typeof createTestFixture>>;

before(async () => {
  fixture = await createTestFixture("workers");
  await writeFile(join(fixture.workspaceRoot, "target.txt"), "old", "utf8");
});

function call(name: string, args: Record<string, unknown>, id = "call_1"): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

function registry(workerAdapter: ReturnType<typeof createScriptedAdapter>): ToolRegistry {
  return new ToolRegistry([createDispatchWorkersTool({
    adapter: workerAdapter,
    store: new SessionStore({ root: fixture.storeRoot }),
    workspaceRoot: fixture.workspaceRoot,
    home: fixture.home,
  })]);
}

describe("dispatch_workers", () => {
  it("runs up to two read-only workers after one exact approval", async () => {
    const workers = createScriptedAdapter({ steps: [{ content: "answer A" }, { content: "answer B" }] });
    let asked = 0;
    let prompt = "";
    const result = await registry(workers).execute(call("dispatch_workers", { subtasks: ["研究 hello.txt 并总结", "统计它有多少行"] }), {
      workspaceRoot: fixture.workspaceRoot,
      approve: async (text) => { asked += 1; prompt = text; return true; },
    });
    assert.equal(asked, 1);
    assert.match(prompt, /研究 hello\.txt 并总结/);
    assert.match(prompt, /统计它有多少行/);
    assert.equal(result.isError, undefined);
    assert.match(result.content, /dispatched 2 worker\(s\)/);
    assert.match(result.content, /1\. ok: answer A/);
    assert.match(result.content, /2\. ok: answer B/);
    assert.equal(workers.consumed, 2);
  });

  it("refuses more than two subtasks before asking anything", async () => {
    const workers = createScriptedAdapter({ steps: [] });
    let asked = 0;
    const result = await registry(workers).execute(call("dispatch_workers", { subtasks: ["a", "b", "c"] }), {
      workspaceRoot: fixture.workspaceRoot,
      approve: async () => { asked += 1; return true; },
    });
    assert.equal(result.isError, true);
    assert.match(result.content, /1 to 2/);
    assert.equal(asked, 0);
    assert.equal(workers.consumed, 0);
  });

  it("refuses an empty or non-string subtask", async () => {
    const workers = createScriptedAdapter({ steps: [] });
    const empty = await registry(workers).execute(call("dispatch_workers", { subtasks: [""] }), { workspaceRoot: fixture.workspaceRoot, approve: async () => true });
    assert.match(empty.content, /non-empty string/);
    const wrongType = await registry(workers).execute(call("dispatch_workers", { subtasks: [5] }), { workspaceRoot: fixture.workspaceRoot, approve: async () => true });
    assert.match(wrongType.content, /must be string/);
    assert.equal(workers.consumed, 0);
  });

  it("declines without running any worker", async () => {
    const workers = createScriptedAdapter({ steps: [] });
    const result = await registry(workers).execute(call("dispatch_workers", { subtasks: ["a"] }), {
      workspaceRoot: fixture.workspaceRoot,
      approve: async () => false,
    });
    assert.equal(result.isError, true);
    assert.match(result.content, /declined/);
    assert.equal(workers.consumed, 0);
  });

  it("isolates one worker's failure and still reports the other's answer", async () => {
    const workers = createScriptedAdapter({ steps: [{ content: "good" }] });
    const result = await registry(workers).execute(call("dispatch_workers", { subtasks: ["first", "second"] }), {
      workspaceRoot: fixture.workspaceRoot,
      approve: async () => true,
    });
    assert.equal(result.isError, true);
    assert.match(result.content, /1\. ok: good/);
    assert.match(result.content, /2\. failed: .*ran out of steps/);
    assert.equal(workers.consumed, 2);
  });

  it("fails closed without an approval channel", async () => {
    const workers = createScriptedAdapter({ steps: [] });
    const result = await registry(workers).execute(call("dispatch_workers", { subtasks: ["a"] }), { workspaceRoot: fixture.workspaceRoot });
    assert.equal(result.isError, true);
    assert.match(result.content, /no approval channel/);
    assert.equal(workers.consumed, 0);
  });
});

describe("worker isolation is structural, not instructed", () => {
  it("exposes only read_file to every worker", () => {
    assert.deepEqual(workerTools().definitions().map((definition) => definition.name), ["read_file"]);
  });

  it("a worker cannot write and cannot dispatch again", async () => {
    const store = new SessionStore({ root: fixture.storeRoot });
    const worker = new AgentRuntime({
      adapter: createScriptedAdapter({ steps: [
        { toolCalls: [call("edit_file", { path: "target.txt", content: "hacked" }, "c1"), call("dispatch_workers", { subtasks: ["again"] }, "c2")] },
        { content: "done" },
      ] }),
      store,
      sessionId: "worker-isolated",
      home: fixture.home,
      workspaceRoot: fixture.workspaceRoot,
      tools: workerTools(),
    });
    const result = await worker.send("do anything");
    assert.equal(result.reply.content, "done");
    const toolResults = (await worker.history()).filter((message) => message.role === "tool").map((message) => message.content);
    assert.match(toolResults.join("\n"), /unknown tool: edit_file/);
    assert.match(toolResults.join("\n"), /unknown tool: dispatch_workers/);
    const { readFile } = await import("node:fs/promises");
    assert.equal(await readFile(join(fixture.workspaceRoot, "target.txt"), "utf8"), "old");
  });
});

describe("the parent loop dispatches and merges", () => {
  it("carries worker answers back as one tool result", async () => {
    const workerAdapter = createScriptedAdapter({ steps: [{ content: "answer A" }, { content: "answer B" }] });
    const parent = new AgentRuntime({
      adapter: createScriptedAdapter({ steps: [
        { toolCalls: [call("dispatch_workers", { subtasks: ["研究 hello", "统计行数"] })] },
        { content: "done" },
      ] }),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: "parent",
      home: fixture.home,
      workspaceRoot: fixture.workspaceRoot,
      approve: async () => true,
      tools: new ToolRegistry([createReadFileTool(), createDispatchWorkersTool({
        adapter: workerAdapter,
        store: new SessionStore({ root: fixture.storeRoot }),
        workspaceRoot: fixture.workspaceRoot,
        home: fixture.home,
      })]),
    });
    const result = await parent.send("分派两个子任务", undefined);
    assert.equal(result.steps, 2);
    assert.equal(result.toolCalls, 1);
    assert.equal(result.reply.content, "done");
    const merged = (await parent.history()).map((message) => message.content).join("\n");
    assert.match(merged, /ok: answer A/);
    assert.match(merged, /ok: answer B/);
    assert.equal(workerAdapter.consumed, 2);
  });
});
