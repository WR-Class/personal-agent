import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { budgetFor, chargeWrite, checkWrite, readWriteAttempt, WriteBudgetError } from "../src/write-budget.ts";
import type { LedgerState } from "../src/write-budget.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { GeneStore } from "../src/gene-store.ts";
import { CycleStore } from "../src/cycle-store.ts";
import { SessionStore } from "../src/session-store.ts";
import type { AuditEvent } from "../src/session-store.ts";
import { ToolRegistry, createEditFileTool, createCreateFileTool, createDeleteFileTool } from "../src/tools.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { mintGene } from "../src/gene.ts";
import { createTestFixture } from "./fixtures.ts";
import type { ToolCall } from "../src/types.ts";

let fixture: Awaited<ReturnType<typeof createTestFixture>>;

before(async () => {
  fixture = await createTestFixture("write-budget");
});

function call(name: string, args: Record<string, unknown>, id = `call_${name}`): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

const EMPTY: LedgerState = { files: [], lines: 0 };

describe("reading a write attempt out of a tool call", () => {
  it("counts lines where the arguments actually carry content", () => {
    const attempt = readWriteAttempt("edit_file", JSON.stringify({ path: "a.ts", content: "one\ntwo\nthree\n" }));
    assert.deepEqual(attempt, { tool: "edit_file", path: "a.ts", lines: 3 });
  });

  it("does not count a trailing newline as an extra line", () => {
    assert.equal(readWriteAttempt("create_file", JSON.stringify({ path: "a", content: "x" }))?.lines, 1);
    assert.equal(readWriteAttempt("create_file", JSON.stringify({ path: "a", content: "" }))?.lines, 0);
  });

  it("counts a file but no lines where the arguments carry none", () => {
    assert.deepEqual(readWriteAttempt("delete_file", JSON.stringify({ path: "a.ts" })), { tool: "delete_file", path: "a.ts", lines: null });
  });

  it("treats unreadable arguments as a write of unknown extent, not a free pass", () => {
    assert.deepEqual(readWriteAttempt("edit_file", "{not json"), { tool: "edit_file", path: null, lines: null });
    assert.deepEqual(readWriteAttempt("edit_file", JSON.stringify({ content: "x" })), { tool: "edit_file", path: null, lines: null });
  });

  it("is not a write at all for a read", () => {
    assert.equal(readWriteAttempt("read_file", JSON.stringify({ path: "a.ts" })), null);
  });
});

describe("the ledger", () => {
  it("counts a file once however often it is written", () => {
    const first = chargeWrite(EMPTY, { tool: "edit_file", path: "a.ts", lines: 2 }, 0);
    const second = chargeWrite(first, { tool: "edit_file", path: "a.ts", lines: 3 }, 1);
    assert.deepEqual(second.files, ["a.ts"]);
    assert.equal(second.lines, 5);
  });

  it("refuses the write that would exceed the file budget, and names it", () => {
    const state = chargeWrite(EMPTY, { tool: "edit_file", path: "a.ts", lines: 1 }, 0);
    const decision = checkWrite(state, { tool: "edit_file", path: "b.ts", lines: 1 }, { maxFiles: 1, maxLines: 10 });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason!, /file budget exhausted/);
    assert.match(decision.reason!, /b\.ts/);
  });

  it("refuses the write that would exceed the line budget", () => {
    const state = chargeWrite(EMPTY, { tool: "edit_file", path: "a.ts", lines: 8 }, 0);
    const decision = checkWrite(state, { tool: "edit_file", path: "a.ts", lines: 5 }, { maxFiles: 5, maxLines: 10 });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason!, /line budget exhausted/);
  });

  it("allows exactly the budget and no more", () => {
    const state = chargeWrite(EMPTY, { tool: "edit_file", path: "a.ts", lines: 10 }, 0);
    assert.equal(checkWrite(state, { tool: "edit_file", path: "a.ts", lines: 0 }, { maxFiles: 1, maxLines: 10 }).allowed, true);
    assert.equal(checkWrite(state, { tool: "edit_file", path: "a.ts", lines: 1 }, { maxFiles: 1, maxLines: 10 }).allowed, false);
  });

  it("still charges an anonymous write, so malformed arguments cannot buy budget", () => {
    const state = chargeWrite(EMPTY, { tool: "edit_file", path: null, lines: null }, 0);
    assert.equal(state.files.length, 1);
    const decision = checkWrite(state, { tool: "edit_file", path: null, lines: null }, { maxFiles: 1, maxLines: 10 });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason!, /no readable path/);
  });

  it("takes the gene's constraints as the budget when there is a gene", () => {
    assert.deepEqual(budgetFor({ maxFiles: 1, maxLines: 20 }, { maxFiles: 3, maxLines: 200 }), { maxFiles: 1, maxLines: 20 });
    assert.deepEqual(budgetFor(null, { maxFiles: 3, maxLines: 200 }), { maxFiles: 3, maxLines: 200 });
  });
});

describe("enforcement in the runtime", () => {
  async function runWithTools(
    steps: ReadonlyArray<{ content: string; toolCalls?: ToolCall[] }>,
    options: { geneStore?: GeneStore; maxWriteFiles?: number; sessionId: string; signalPrompt?: string },
  ) {
    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({ steps: [...steps] }),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: options.sessionId,
      home: fixture.home,
      workspaceRoot: fixture.workspaceRoot,
      cycleStore: new CycleStore(join(fixture.root, `cycles-${options.sessionId}.jsonl`)),
      ...(options.geneStore ? { geneStore: options.geneStore } : {}),
      ...(options.maxWriteFiles === undefined ? {} : { maxWriteFiles: options.maxWriteFiles }),
      tools: new ToolRegistry([createEditFileTool(), createCreateFileTool(), createDeleteFileTool()]),
      approve: async () => true,
    });
    return runtime.send(options.signalPrompt ?? "改一下文件");
  }

  it("refuses the second distinct file when the file budget allows one", async () => {
    const first = join(fixture.workspaceRoot, "one.txt");
    const second = join(fixture.workspaceRoot, "two.txt");
    await writeFile(first, "keep1\n", "utf8");
    await writeFile(second, "keep2\n", "utf8");

    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({
        steps: [
          {
            content: "",
            toolCalls: [
              call("edit_file", { path: "one.txt", content: "w1\n" }, "call_a"),
              call("edit_file", { path: "two.txt", content: "w2\n" }, "call_b"),
            ],
          },
          { content: "done" },
        ],
      }),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: "budget-files", home: fixture.home, workspaceRoot: fixture.workspaceRoot,
      maxWriteFiles: 1, maxWriteLines: 100,
      tools: new ToolRegistry([createEditFileTool()]),
      approve: async () => true,
    });

    const result = await runtime.send("改两个文件");
    assert.equal(await readFile(first, "utf8"), "w1\n");
    assert.equal(await readFile(second, "utf8"), "keep2\n", "the over-budget file must be untouched");
    assert.equal(result.budget.filesWritten, 1);
    assert.equal(result.evaluation.status, "partial");
  });

  it("refuses on the line budget before the tool runs, leaving no tool message", async () => {
    const target = join(fixture.workspaceRoot, "lines.txt");
    await writeFile(target, "keep\n", "utf8");
    const store = new SessionStore({ root: fixture.storeRoot });
    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({
        steps: [
          { content: "", toolCalls: [call("edit_file", { path: "lines.txt", content: "a\nb\nc\nd\n" })] },
          { content: "done" },
        ],
      }),
      store, sessionId: "budget-lines", home: fixture.home, workspaceRoot: fixture.workspaceRoot,
      maxWriteLines: 3,
      tools: new ToolRegistry([createEditFileTool()]),
      approve: async () => true,
    });

    const result = await runtime.send("改文件");
    // The write was refused, so the file still holds its original content.
    assert.equal(await readFile(target, "utf8"), "keep\n");
    // The refusal is visible as a failed tool result, not a silent skip.
    assert.equal(result.evaluation.status, "partial");
    const history = await store.history("budget-lines");
    const refusal = history.find((message) => message.role === "tool" && message.content.startsWith("refused:"));
    assert.ok(refusal, "expected a recorded refusal");
    assert.match(refusal!.content, /line budget exhausted/);
  });

  it("records the refusal in the audit log", async () => {
    const target = join(fixture.workspaceRoot, "audited.txt");
    await writeFile(target, "keep\n", "utf8");
    const store = new SessionStore({ root: fixture.storeRoot });
    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({
        steps: [
          { content: "", toolCalls: [call("edit_file", { path: "audited.txt", content: "a\nb\nc\n" })] },
          { content: "done" },
        ],
      }),
      store, sessionId: "budget-audit", home: fixture.home, workspaceRoot: fixture.workspaceRoot,
      maxWriteLines: 1,
      tools: new ToolRegistry([createEditFileTool()]),
      approve: async () => true,
    });
    await runtime.send("改文件");

    const { events } = await store.inspect("budget-audit");
    const audits = events.filter((event): event is AuditEvent => event.kind === "audit");
    const denied = audits.find((event) => event.decision === "denied" && event.reason.includes("write budget"));
    assert.ok(denied, `expected a write-budget audit event, got ${JSON.stringify(audits)}`);
  });

  it("charges a performed write and reports it against the budget", async () => {
    const target = join(fixture.workspaceRoot, "charged.txt");
    await writeFile(target, "old\n", "utf8");
    const result = await runWithTools(
      [
        { content: "", toolCalls: [call("edit_file", { path: "charged.txt", content: "new\n" })] },
        { content: "done" },
      ],
      { sessionId: "budget-charge" },
    );
    assert.equal(await readFile(target, "utf8"), "new\n");
    assert.equal(result.budget.filesWritten, 1);
    assert.equal(result.budget.linesWritten, 1);
    assert.equal(result.budget.filesWrittenLimit, 3);
  });

  it("lets a gene's own constraints bound the round", async () => {
    const target = join(fixture.workspaceRoot, "gene-bounded.txt");
    await writeFile(target, "keep\n", "utf8");

    const geneStore = new GeneStore(join(fixture.root, "gene-budget.jsonl"));
    const minted = mintGene({
      name: "tight", intent: "build", signalsMatch: ["改一下文件"], preconditions: [],
      strategy: [{ kind: "act", text: "改" }, { kind: "verify", text: "查" }],
      constraints: { maxFiles: 1, maxLines: 1, forbiddenPaths: [] },
      validation: ["npm.cmd test"], avoid: [],
    });
    await geneStore.appendGene(minted);

    const store = new SessionStore({ root: fixture.storeRoot });
    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({
        steps: [
          { content: "", toolCalls: [call("edit_file", { path: "gene-bounded.txt", content: "a\nb\nc\n" })] },
          { content: "done" },
        ],
      }),
      store, sessionId: "gene-bounded", home: fixture.home, workspaceRoot: fixture.workspaceRoot,
      geneStore, cycleStore: new CycleStore(join(fixture.root, "cycles-gene-bounded.jsonl")),
      // The runtime default would allow 200 lines; the gene allows 1.
      maxWriteLines: 200,
      tools: new ToolRegistry([createEditFileTool()]),
      approve: async () => true,
    });

    const result = await runtime.send("改一下文件");
    assert.equal(result.appliedGene?.address, minted.address);
    assert.equal(result.budget.linesWrittenLimit, 1);
    assert.equal(await readFile(target, "utf8"), "keep\n");
  });

  it("classifies an exhausted write budget as a budget failure", () => {
    const error = new WriteBudgetError("cycle file budget exhausted");
    assert.equal(error.name, "WriteBudgetError");
  });
});
