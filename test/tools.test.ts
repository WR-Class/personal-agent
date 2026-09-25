import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join } from "node:path";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { SessionCorruptionError, SessionStore, migrateEvent } from "../src/session-store.ts";
import { AgentRuntime, ContextBudgetError, DEFAULT_MAX_STEPS, DeadlineExceededError, StepLimitError, TokenBudgetError, ToolBudgetError, formatBudget } from "../src/runtime.ts";
import { access } from "node:fs/promises";
import { ToolRegistry, createCreateFileTool, createDeleteFileTool, createEditFileTool, createReadFileTool } from "../src/tools.ts";
import { assertReadablePath, configuredContextWindows } from "../src/security-config.ts";
import { readBoundedUtf8 } from "../src/bounded-read.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import type { ScriptedStep } from "../src/echo-adapter.ts";
import type { ChatMessage, ToolCall } from "../src/types.ts";
import { createTestFixture } from "./fixtures.ts";

let root = "";
let storeRoot = "";
let home = "";

before(async () => {
  const fixture = await createTestFixture("tools");
  root = fixture.root;
  storeRoot = fixture.storeRoot;
  home = fixture.home;
  await mkdir(join(root, "workspace", "nested"), { recursive: true });
  await writeFile(join(root, "workspace", "hello.txt"), "file contents here", "utf8");
  await writeFile(join(root, "workspace", "nested", "deep.txt"), "nested", "utf8");
  await writeFile(join(root, "outside.txt"), "should never be readable", "utf8");
});

function workspace(): string {
  return join(root, "workspace");
}

function makeRegistry(): ToolRegistry {
  return new ToolRegistry([createReadFileTool()]);
}

function call(name: string, args: Record<string, unknown>, id = "call_1"): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

function makeRuntime(
  sessionId: string,
  steps: ScriptedStep[],
  options: {
    maxSteps?: number;
    maxToolCallsPerStep?: number;
    maxToolCallsPerRun?: number;
    deadlineMs?: number;
    maxContextBytes?: number;
    maxContextTokens?: number;
    countPromptTokens?: (messages: readonly ChatMessage[]) => number;
  } = {},
) {
  const adapter = createScriptedAdapter({ steps });
  const runtime = new AgentRuntime({
    adapter,
    store: new SessionStore({ root: storeRoot }),
    sessionId,
    home,
    workspaceRoot: workspace(),
    tools: makeRegistry(),
    ...(options.maxSteps === undefined ? {} : { maxSteps: options.maxSteps }),
    ...(options.maxToolCallsPerStep === undefined ? {} : { maxToolCallsPerStep: options.maxToolCallsPerStep }),
    ...(options.maxToolCallsPerRun === undefined ? {} : { maxToolCallsPerRun: options.maxToolCallsPerRun }),
    ...(options.deadlineMs === undefined ? {} : { deadlineMs: options.deadlineMs }),
    ...(options.maxContextBytes === undefined ? {} : { maxContextBytes: options.maxContextBytes }),
    ...(options.maxContextTokens === undefined ? {} : { maxContextTokens: options.maxContextTokens }),
    ...(options.countPromptTokens === undefined ? {} : { countPromptTokens: options.countPromptTokens }),
  });
  return { runtime, adapter };
}

describe("edit_file", () => {
  it("replaces one existing file only after approval", async () => {
    await writeFile(join(workspace(), "editable.txt"), "old text", "utf8");
    let asked = 0;
    let prompt = "";
    const registry = new ToolRegistry([createEditFileTool()]);
    const result = await registry.execute(call("edit_file", { path: "editable.txt", content: "new text" }), {
      workspaceRoot: workspace(),
      approve: async (text) => { asked += 1; prompt = text; return true; },
    });
    assert.equal(result.isError, undefined);
    assert.equal(asked, 1);
    assert.match(prompt, /- old text/);
    assert.match(prompt, /\+ new text/);
    assert.equal(await readFile(join(workspace(), "editable.txt"), "utf8"), "new text");
  });

  it("declines without writing and never creates a file", async () => {
    const registry = new ToolRegistry([createEditFileTool()]);
    const declined = await registry.execute(call("edit_file", { path: "editable.txt", content: "nope" }), {
      workspaceRoot: workspace(),
      approve: async () => false,
    });
    assert.equal(declined.isError, true);
    assert.match(declined.content, /declined/);
    const missing = await registry.execute(call("edit_file", { path: "new.txt", content: "created" }), {
      workspaceRoot: workspace(),
      approve: async () => true,
    });
    assert.match(missing.content, /no such file/);
  });

  it("rejects a yes that arrives after two minutes", async () => {
    await writeFile(join(workspace(), "editable.txt"), "old text", "utf8");
    const original = Date.now;
    let calls = 0;
    Date.now = () => calls++ === 0 ? 1_000 : 1_000 + 2 * 60 * 1000 + 1;
    try {
      const result = await new ToolRegistry([createEditFileTool()]).execute(
        call("edit_file", { path: "editable.txt", content: "late" }),
        { workspaceRoot: workspace(), approve: async () => true },
      );
      assert.match(result.content, /expired/);
      assert.equal(await readFile(join(workspace(), "editable.txt"), "utf8"), "old text");
    } finally {
      Date.now = original;
    }
  });

  it("keeps every other side-effect tool closed", async () => {
    const registry = new ToolRegistry([{
      name: "move_file", description: "no", parameters: { type: "object" }, readOnly: false,
      async execute() { return { content: "ran" }; },
    }]);
    const result = await registry.execute(call("move_file", {}), { workspaceRoot: workspace() });
    assert.match(result.content, /side-effect tools are disabled/);
  });
});

describe("create_file", () => {
  it("creates one new file after approval and refuses an existing one", async () => {
    const registry = new ToolRegistry([createCreateFileTool()]);
    const created = await registry.execute(call("create_file", { path: "fresh.txt", content: "hello\n" }), {
      workspaceRoot: workspace(), approve: async () => true,
    });
    assert.equal(created.isError, undefined);
    assert.equal(await readFile(join(workspace(), "fresh.txt"), "utf8"), "hello\n");
    const again = await registry.execute(call("create_file", { path: "fresh.txt", content: "other" }), {
      workspaceRoot: workspace(), approve: async () => true,
    });
    assert.match(again.content, /already exists/);
  });
});

describe("delete_file", () => {
  it("deletes one approved file and refuses a directory", async () => {
    await writeFile(join(workspace(), "gone.txt"), "bye", "utf8");
    const registry = new ToolRegistry([createDeleteFileTool()]);
    const result = await registry.execute(call("delete_file", { path: "gone.txt" }), { workspaceRoot: workspace(), approve: async () => true });
    assert.equal(result.isError, undefined);
    await assert.rejects(() => access(join(workspace(), "gone.txt")));
    const directory = await registry.execute(call("delete_file", { path: "nested" }), { workspaceRoot: workspace(), approve: async () => true });
    assert.match(directory.content, /not a regular file/);
  });
});

describe("read_file tool and path confinement", () => {
  it("reads a file inside the workspace", async () => {
    const result = await makeRegistry().execute(call("read_file", { path: "hello.txt" }), {
      workspaceRoot: workspace(),
    });
    assert.equal(result.isError, undefined);
    assert.equal(result.content, "file contents here");
  });

  it("reads a nested relative path", async () => {
    const result = await makeRegistry().execute(call("read_file", { path: "nested/deep.txt" }), {
      workspaceRoot: workspace(),
    });
    assert.equal(result.content, "nested");
  });

  it("refuses to escape the workspace with ..", async () => {
    const result = await makeRegistry().execute(call("read_file", { path: "../outside.txt" }), {
      workspaceRoot: workspace(),
    });
    assert.equal(result.isError, true);
    assert.match(result.content, /escapes the workspace/);
    assert.doesNotMatch(result.content, /should never be readable/);
  });

  it("refuses an absolute path outside the workspace", async () => {
    const result = await makeRegistry().execute(call("read_file", { path: join(root, "outside.txt") }), {
      workspaceRoot: workspace(),
    });
    assert.equal(result.isError, true);
    assert.match(result.content, /escapes the workspace/);
  });

  it("refuses a relentless traversal", async () => {
    const result = await makeRegistry().execute(call("read_file", { path: "nested/../../outside.txt" }), {
      workspaceRoot: workspace(),
    });
    assert.equal(result.isError, true);
  });

  it("refuses a symlink that points outside the workspace", async (context) => {
    const link = join(workspace(), "escape-link.txt");
    try {
      await symlink(join(root, "outside.txt"), link, "file");
    } catch {
      // Creating symlinks needs privileges on Windows; the lexical fence still
      // holds, so this case is reported as skipped rather than silently passed.
      context.skip("symlink creation is not permitted in this environment");
      return;
    }
    const result = await makeRegistry().execute(call("read_file", { path: "escape-link.txt" }), {
      workspaceRoot: workspace(),
    });
    assert.equal(result.isError, true);
    assert.match(result.content, /escapes the workspace/);
  });

  it("resolves inside the workspace through the one policy implementation", () => {
    // PT04: `resolveInside` was deleted, so these properties are asserted against
    // the surviving implementation instead of a second one that could drift.
    // Coverage migrated: lexical containment, sibling name prefix, sensitive
    // name in the requested spelling AND after resolution, missing leaf.
    const root = workspace();
    const inside = assertReadablePath(join(root, "hello.txt"), root);
    assert.equal(inside, join(realpathSync.native(root), "hello.txt"), "returns the canonical target");

    // A leaf that does not exist yet is a missing-leaf case, not an escape: the
    // nearest existing ancestor decides, so the read still reports "no such file"
    // rather than a policy refusal.
    assert.equal(assertReadablePath(join(root, "nope.txt"), root), join(realpathSync.native(root), "nope.txt"));

    assert.throws(() => assertReadablePath(join(root, "..", "outside.txt"), root), /escapes the workspace/);
    assert.throws(() => assertReadablePath(join(`${root}-evil`, "x.txt"), root), /escapes the workspace/);
    // Sensitive names are refused on the spelling the caller used, even when the
    // canonical path would look innocent, and vice versa.
    assert.throws(() => assertReadablePath(join(root, ".env"), root), /sensitive path is denied/);
    assert.throws(() => assertReadablePath(join(root, ".ssh", "id_rsa"), root), /sensitive path is denied/);
    // Choosing a sensitive directory as the workspace must not remove protection
    // from what is inside it.
    const sensitiveWorkspace = join(root, ".aws");
    assert.throws(
      () => assertReadablePath(join(sensitiveWorkspace, "config"), sensitiveWorkspace),
      /sensitive path is denied/,
    );
  });

  it("is not fooled by a sibling directory sharing a name prefix", async () => {
    // `/work-evil` must not count as being inside `/work`.
    await mkdir(`${workspace()}-evil`, { recursive: true });
    await writeFile(join(`${workspace()}-evil`, "x.txt"), "sibling", "utf8");
    const result = await makeRegistry().execute(call("read_file", { path: join(`${workspace()}-evil`, "x.txt") }), {
      workspaceRoot: workspace(),
    });
    assert.equal(result.isError, true);
    assert.match(result.content, /escapes the workspace/);
  });

  it("reports a missing file as an error result rather than throwing", async () => {
    const result = await makeRegistry().execute(call("read_file", { path: "nope.txt" }), {
      workspaceRoot: workspace(),
    });
    assert.equal(result.isError, true);
    assert.match(result.content, /no such file/);
  });

  it("rejects a missing or non-string path argument", async () => {
    const result = await makeRegistry().execute(call("read_file", {}), { workspaceRoot: workspace() });
    assert.equal(result.isError, true);
    assert.match(result.content, /non-empty string/);
  });

  it("rejects a directory", async () => {
    const result = await makeRegistry().execute(call("read_file", { path: "nested" }), {
      workspaceRoot: workspace(),
    });
    assert.equal(result.isError, true);
    assert.match(result.content, /not a regular file/);
  });

  it("reads a file exactly at the byte limit and refuses one byte more", async () => {
    const limit = 256 * 1024;
    await writeFile(join(root, "workspace", "at-limit.txt"), "a".repeat(limit), "utf8");
    await writeFile(join(root, "workspace", "over-limit.txt"), "a".repeat(limit + 1), "utf8");
    const context = { workspaceRoot: workspace() };
    const ok = await makeRegistry().execute(call("read_file", { path: "at-limit.txt" }), context);
    assert.equal(ok.isError, undefined);
    assert.equal(ok.content.length, limit);
    const over = await makeRegistry().execute(call("read_file", { path: "over-limit.txt" }), context);
    assert.equal(over.isError, true);
    assert.match(over.content, /over the 262144-byte limit/);
  });
});

describe("bounded byte ceiling", () => {
  it("stops a stream that never ends instead of buffering it", async () => {
    async function* endless(): AsyncIterable<Uint8Array> {
      for (;;) yield new Uint8Array(64 * 1024);
    }
    // Terminating at all is the point: an unbounded reader would hang or exhaust memory here.
    await assert.rejects(() => readBoundedUtf8(endless(), 128 * 1024, "stream"), /exceeds the 131072-byte limit/);
  });

  it("counts bytes, not characters", async () => {
    async function* chunks(): AsyncIterable<Uint8Array> {
      yield Buffer.from("汉字", "utf8");
    }
    assert.equal(await readBoundedUtf8(chunks(), 6, "stream"), "汉字");
    await assert.rejects(() => readBoundedUtf8(chunks(), 5, "stream"), /exceeds the 5-byte limit/);
  });

  it("refuses to run a tool whose schema declares unsupported semantics", async () => {
    let executed = 0;
    const registry = new ToolRegistry([{
      name: "exotic",
      description: "declares a keyword this project cannot verify",
      parameters: { type: "object", oneOf: [{ type: "string" }] },
      readOnly: true,
      async execute() { executed += 1; return { content: "ran" }; },
    }]);
    const result = await registry.execute(call("exotic", {}), { workspaceRoot: workspace() });
    assert.equal(result.isError, true);
    assert.match(result.content, /oneOf: keyword is not supported/);
    assert.doesNotMatch(result.content, /threw/);
    assert.equal(executed, 0);
  });

  it("validates arguments against the declared schema before the executor runs", async () => {
    let executed = 0;
    const registry = new ToolRegistry([{
      name: "shaped",
      description: "declares types, an enum, required keys and a closed object",
      parameters: {
        type: "object",
        properties: {
          mode: { type: "string", enum: ["read", "write"] },
          count: { type: "integer" },
        },
        required: ["mode"],
        additionalProperties: false,
      },
      readOnly: true,
      async execute() { executed += 1; return { content: "ran" }; },
    }]);
    const context = { workspaceRoot: workspace() };
    const bad = async (args: Record<string, unknown>) => registry.execute(call("shaped", args), context);
    assert.match((await bad({})).content, /non-empty string/);
    assert.match((await bad({ mode: "delete" })).content, /enum values/);
    assert.match((await bad({ mode: "read", extra: 1 })).content, /is not allowed/);
    assert.match((await bad({ mode: "read", count: 1.5 })).content, /count must be integer/);
    assert.equal(executed, 0);
    const ok = await bad({ mode: "read", count: 2 });
    assert.equal(ok.isError, undefined);
    assert.equal(ok.content, "ran");
    assert.equal(executed, 1);
  });
});

describe("tool registry", () => {
  it("reports an unknown tool instead of throwing", async () => {
    const result = await makeRegistry().execute(call("nope", {}), { workspaceRoot: workspace() });
    assert.equal(result.isError, true);
    assert.match(result.content, /unknown tool: nope/);
  });

  it("reports malformed JSON arguments", async () => {
    const registry = makeRegistry();
    const result = await registry.execute({ id: "c", name: "read_file", arguments: "{not json" }, {
      workspaceRoot: workspace(),
    });
    assert.equal(result.isError, true);
    assert.match(result.content, /not valid JSON/);
  });

  it("treats empty arguments as an empty object", async () => {
    const result = await makeRegistry().execute({ id: "c", name: "read_file", arguments: "" }, {
      workspaceRoot: workspace(),
    });
    assert.equal(result.isError, true);
    assert.match(result.content, /non-empty string/);
  });

  it("rejects a duplicate tool name", () => {
    const registry = makeRegistry();
    assert.throws(() => registry.register(createReadFileTool()), /duplicate tool name/);
  });

  it("advertises tool definitions to the model", () => {
    const [definition] = makeRegistry().definitions();
    assert.equal(definition!.name, "read_file");
    assert.equal(definition!.parameters.type, "object");
  });
});

describe("agent loop with tools", () => {
  it("runs a tool, feeds the result back, and finishes in two steps", async () => {
    const { runtime, adapter } = makeRuntime("loop-tools", [
      { content: "let me look", toolCalls: [call("read_file", { path: "hello.txt" })] },
      { content: "the file says: file contents here" },
    ]);

    const result = await runtime.send("read hello.txt");

    assert.equal(result.steps, 2, "one step to request the tool, one to answer");
    assert.equal(result.toolCalls, 1);
    assert.equal(result.reply.content, "the file says: file contents here");

    // The second model call must actually have been given the file contents.
    const secondPrompt = adapter.requests[1]!.messages;
    const toolMessage = secondPrompt.find((message) => message.role === "tool");
    assert.ok(toolMessage, "the tool result must be fed back to the model");
    assert.equal(toolMessage.content, "file contents here");
    assert.equal(toolMessage.toolCallId, "call_1");

    // And the assistant turn that requested it must be replayed with its calls.
    const assistant = secondPrompt.find((message) => message.role === "assistant");
    assert.equal(assistant?.toolCalls?.[0]?.name, "read_file");
  });

  it("offers the tool definitions on every step", async () => {
    const { runtime, adapter } = makeRuntime("offers", [{ content: "no tools needed" }]);
    await runtime.send("hi");
    assert.equal(adapter.requests[0]!.tools?.[0]?.name, "read_file");
  });

  it("makes no tool call and one step when the model answers directly", async () => {
    const { runtime } = makeRuntime("direct", [{ content: "just talking" }]);
    const result = await runtime.send("hi");
    assert.equal(result.steps, 1);
    assert.equal(result.toolCalls, 0);
  });

  it("runs several calls from one step in model order", async () => {
    const { runtime, adapter } = makeRuntime("multi", [
      {
        content: "",
        toolCalls: [call("read_file", { path: "hello.txt" }, "c1"), call("read_file", { path: "nested/deep.txt" }, "c2")],
      },
      { content: "done" },
    ]);

    const result = await runtime.send("read two files");
    assert.equal(result.toolCalls, 2);
    assert.equal(result.steps, 2);

    const toolMessages = adapter.requests[1]!.messages.filter((message) => message.role === "tool");
    assert.deepEqual(
      toolMessages.map((message) => message.toolCallId),
      ["c1", "c2"],
      "results must be fed back in the order the model requested them",
    );
    assert.deepEqual(toolMessages.map((message) => message.content), ["file contents here", "nested"]);
  });

  it("stops at maxSteps when the model keeps asking for tools", async () => {
    const forever = Array.from({ length: DEFAULT_MAX_STEPS + 5 }, () => ({
      toolCalls: [call("read_file", { path: "hello.txt" })],
    }));
    const { runtime, adapter } = makeRuntime("limit", forever, { maxSteps: 3 });

    await assert.rejects(() => runtime.send("go"), StepLimitError);
    assert.equal(adapter.consumed, 3, "the cap must bound model calls, not just loop iterations");

    // The cap is a termination guarantee, so what ran must still be auditable.
    const { events } = await new SessionStore({ root: storeRoot }).inspect("limit");
    const toolMessages = events.filter((event) => event.kind === "message" && event.message.role === "tool");
    assert.equal(toolMessages.length, 3);
    assert.equal(
      events.filter((event) => event.kind === "tool/call" || event.kind === "tool/result").length,
      0,
      "ADR-0001: the audit pair is no longer written",
    );
  });

  it("uses 10 steps by default", () => {
    assert.equal(DEFAULT_MAX_STEPS, 10);
  });

  it("rejects a non-positive maxSteps at construction", () => {
    assert.throws(() => makeRuntime("bad", [{ content: "x" }], { maxSteps: 0 }), /positive integer/);
  });

  it("refuses a step that asks for more tools than the per-step budget", async () => {
    const many = Array.from({ length: 4 }, (_, index) => call("read_file", { path: "hello.txt" }, `c${index}`));
    const { runtime } = makeRuntime("step-budget", [{ content: "", toolCalls: many }, { content: "done" }], {
      maxToolCallsPerStep: 3,
    });

    await assert.rejects(() => runtime.send("go"), (error: unknown) => {
      assert.ok(error instanceof ToolBudgetError);
      assert.equal(error.scope, "step");
      assert.equal(error.limit, 3);
      return true;
    });

    // A refused step must leave no trace: no assistant turn, no call, no result.
    const { events, problems } = await new SessionStore({ root: storeRoot }).inspect("step-budget");
    assert.deepEqual(problems, []);
    assert.deepEqual(events.map((event) => event.kind), ["session", "message"]);
    assert.deepEqual((await runtime.history()).map((message) => message.role), ["user"]);
  });

  it("stops a run once the cumulative tool budget is spent and pairs what it already issued", async () => {
    const pair = [call("read_file", { path: "hello.txt" }, "a1"), call("read_file", { path: "hello.txt" }, "a2")];
    const { runtime } = makeRuntime("run-budget", [
      { content: "", toolCalls: pair },
      { content: "", toolCalls: pair },
      { content: "done" },
    ], { maxToolCallsPerRun: 3 });

    await assert.rejects(() => runtime.send("go"), (error: unknown) => {
      assert.ok(error instanceof ToolBudgetError);
      assert.equal(error.scope, "run");
      assert.equal(error.limit, 3);
      return true;
    });

    // The first step ran and was recorded in full; the second was refused whole.
    const { events, problems } = await new SessionStore({ root: storeRoot }).inspect("run-budget");
    assert.deepEqual(problems, []);
    assert.equal(events.filter((event) => event.kind === "message" && event.message.role === "tool").length, 2);
  });

  it("stops the run at the deadline and still answers every tool it already issued", async () => {
    const pair = [call("read_file", { path: "hello.txt" }, "d1"), call("read_file", { path: "hello.txt" }, "d2")];
    const adapter = createScriptedAdapter({
      steps: [{ content: "", toolCalls: pair }, { content: "", toolCalls: pair }, { content: "done" }],
    });
    // The adapter ignores the signal, which is the hard case: the deadline must
    // still stop the loop, and it must not be relabelled into a plain abort.
    const runtime = new AgentRuntime({
      adapter,
      store: new SessionStore({ root: storeRoot }),
      sessionId: "deadline",
      home,
      workspaceRoot: workspace(),
      tools: makeRegistry(),
      deadlineMs: 1,
    });

    await assert.rejects(() => runtime.send("go"), (error: unknown) => {
      assert.ok(error instanceof DeadlineExceededError || error instanceof ToolBudgetError, String(error));
      return true;
    });

    const { problems } = await new SessionStore({ root: storeRoot }).inspect("deadline");
    assert.deepEqual(problems, [], "a deadline stop must not leave an unanswered tool group");
  });

  it("reports what a send used and how much remains", async () => {
    const { runtime } = makeRuntime(
      "budget-report",
      [
        { toolCalls: [call("read_file", { path: "hello.txt" })], usage: { inputTokens: 40, outputTokens: 7 } },
        { content: "done", usage: { inputTokens: 120, outputTokens: 3 } },
      ],
      { maxSteps: 5, maxToolCallsPerRun: 9, maxContextBytes: 4096, maxContextTokens: 1000 },
    );
    const { budget } = await runtime.send("hello");

    assert.equal(budget.stepsUsed, 2);
    assert.equal(budget.maxSteps, 5);
    assert.equal(budget.toolCallsUsed, 1);
    assert.equal(budget.maxToolCallsPerRun, 9);
    // Used and limit are both reported, so the caller does the subtraction once.
    assert.equal(budget.maxContextBytes, 4096);
    assert.ok(budget.promptBytes > 0, "the bytes of the prompt actually sent are reported");
    assert.equal(budget.inputTokens, 120, "the provider's own count for the last call, not a sum");
    assert.equal(budget.maxContextTokens, 1000);
    assert.ok(budget.elapsedMs >= 0 && budget.deadlineMs > 0);

    const line = formatBudget(budget);
    assert.match(line, /步骤 2\/5/);
    assert.match(line, /工具 1\/9/);
    assert.match(line, /令牌 120\/1000\(剩880\)/);
    assert.match(line, /prompt \d/);
  });

  it("prints an unmeasured token count as unmeasured instead of inventing headroom", async () => {
    // A send can finish before any reply reports tokens (a first-call refusal path
    // is not the only way); the display must not then look reassuring.
    const line = formatBudget({
      stepsUsed: 0, maxSteps: 10, toolCallsUsed: 0, maxToolCallsPerRun: 32,
      promptBytes: 12, maxContextBytes: 1024, maxContextTokens: 500,
      elapsedMs: 5, deadlineMs: 1000,
    });
    assert.match(line, /令牌 未测量\/500/);
    assert.ok(!line.includes("剩"), "no remainder is shown when nothing was measured");

    // And a measured count above the ceiling reads as over, not as a negative remainder.
    const over = formatBudget({
      stepsUsed: 1, maxSteps: 10, toolCallsUsed: 0, maxToolCallsPerRun: 32,
      promptBytes: 12, maxContextBytes: 1024, inputTokens: 620, maxContextTokens: 500,
      elapsedMs: 5, deadlineMs: 1000,
    });
    assert.match(over, /令牌 620\/500\(超120\)/);
  });

  it("applies a per-model window, replacing the global token ceiling", async () => {
    const makeWindowed = (sessionId: string, model: string, contextWindows: Record<string, number>) =>
      new AgentRuntime({
        adapter: createScriptedAdapter({
          // The only call reports 40 input tokens, so the *next* check is the one
          // that decides — which is where a per-model window has to be in force.
          steps: [
            { toolCalls: [call("read_file", { path: "hello.txt" })], usage: { inputTokens: 40, outputTokens: 5 } },
            { content: "answered" },
          ],
          model,
        }),
        store: new SessionStore({ root: storeRoot }),
        sessionId,
        home,
        workspaceRoot: workspace(),
        tools: makeRegistry(),
        maxContextTokens: 100_000,
        contextWindows,
      });

    // 40 tokens is under the window; the global ceiling would have allowed far more.
    const wide = makeWindowed("window-fits", "small-model", { "small-model": 100 });
    assert.equal((await wide.send("hi")).reply.content, "answered");

    // The same 40-token report now exceeds the window, and the error names the
    // window rather than the global default — otherwise the message would point
    // at a number that is not the one in force.
    const narrow = makeWindowed("window-tight", "small-model", { "small-model": 30 });
    await assert.rejects(
      () => narrow.send("hi"),
      (error: unknown) => {
        assert.ok(error instanceof TokenBudgetError);
        assert.equal(error.limit, 30, "the per-model window is the ceiling, not the global default");
        return true;
      },
    );

    // A model with no exact entry falls back to "*"; a model matching neither uses
    // the global ceiling, so an unlisted model is not left unguarded.
    const wildcard = makeWindowed("window-wild", "other-model", { "*": 30 });
    await assert.rejects(() => wildcard.send("hi"), TokenBudgetError);
    const unlisted = makeWindowed("window-none", "other-model", { "small-model": 30 });
    assert.equal((await unlisted.send("hi")).reply.content, "answered");
  });

  it("rejects a malformed window map rather than ignoring it", () => {
    const base = { store: new SessionStore({ root: storeRoot }), sessionId: "bad-window", home, workspaceRoot: workspace() };
    assert.throws(() => new AgentRuntime({ ...base, adapter: createScriptedAdapter({ steps: [] }), contextWindows: { m: 0 } }), /positive integer/);
    assert.throws(() => new AgentRuntime({ ...base, adapter: createScriptedAdapter({ steps: [] }), contextWindows: { m: 1.5 } }), /positive integer/);
    assert.throws(() => new AgentRuntime({ ...base, adapter: createScriptedAdapter({ steps: [] }), contextWindows: { "  ": 10 } }), /non-empty/);
  });

  it("parses per-model windows from the environment and refuses bad ones", () => {
    assert.deepEqual(configuredContextWindows({ PERSONAL_AGENT_CONTEXT_WINDOWS: '{"a":1,"*":2}' }), { a: 1, "*": 2 });
    assert.equal(configuredContextWindows({}), undefined);
    assert.equal(configuredContextWindows({ PERSONAL_AGENT_CONTEXT_WINDOWS: "   " }), undefined);
    assert.equal(configuredContextWindows({ PERSONAL_AGENT_CONTEXT_WINDOWS: "{}" }), undefined);
    assert.throws(() => configuredContextWindows({ PERSONAL_AGENT_CONTEXT_WINDOWS: "[1,2]" }), /JSON object/);
    assert.throws(() => configuredContextWindows({ PERSONAL_AGENT_CONTEXT_WINDOWS: '{"a":-1}' }), /positive integer/);
    assert.throws(() => configuredContextWindows({ PERSONAL_AGENT_CONTEXT_WINDOWS: '{"a":"big"}' }), /positive integer/);
    assert.throws(() => configuredContextWindows({ PERSONAL_AGENT_CONTEXT_WINDOWS: '{" " :1}' }), /non-empty/);
    assert.throws(() => configuredContextWindows({ PERSONAL_AGENT_CONTEXT_WINDOWS: "{oops" }), SyntaxError);
  });

  it("uses a host tokenizer to refuse an over-size prompt before any call", async () => {
    // This closes the gap that makes the provider-based ceiling one call late: a
    // real tokenizer can judge the prompt that is about to be sent.
    let calls = 0;
    const { runtime, adapter } = makeRuntime("host-tokens", [{ content: "never reached" }], {
      maxContextTokens: 1000,
      countPromptTokens: (messages) => {
        calls += 1;
        return messages.reduce((total, message) => total + message.content.length, 0);
      },
    });

    await assert.rejects(
      () => runtime.send("x".repeat(1200)),
      (error: unknown) => {
        assert.ok(error instanceof TokenBudgetError);
        assert.equal(error.source, "host", "the message must not blame the provider for a host count");
        assert.equal(error.limit, 1000);
        assert.match((error as Error).message, /host tokenizer/);
        return true;
      },
    );
    assert.equal(adapter.consumed, 0, "an over-size prompt is refused without a call");
    assert.ok(calls > 0, "the injected counter is what made the decision");
    const history = await new SessionStore({ root: storeRoot }).history("host-tokens");
    assert.deepEqual(history, [], "and the refusal leaves no unanswerable turn");
  });

  it("reports the host count for the prompt actually sent", async () => {
    const { runtime } = makeRuntime("host-count", [{ content: "ok", usage: { inputTokens: 7, outputTokens: 2 } }], {
      maxContextTokens: 1000,
      countPromptTokens: (messages) => messages.reduce((total, message) => total + message.content.length, 0),
    });
    const { budget } = await runtime.send("twelve chars");
    assert.equal(budget.predictedTokens, 12, "the prompt itself, not the provider's previous call");
    assert.equal(budget.inputTokens, 7, "the provider's own count is still reported separately");
    assert.match(formatBudget(budget), /令牌 12\/1000\(剩988\)\(本机\)/);
  });

  it("refuses a host counter that returns something other than a count", async () => {
    // Fail loudly: a counter returning NaN would otherwise disable the ceiling
    // while still looking like it was configured.
    for (const bad of [Number.NaN, -1, 1.5, Number.POSITIVE_INFINITY]) {
      const { runtime } = makeRuntime(`host-bad-${String(bad).slice(0, 4)}`, [{ content: "ok" }], {
        countPromptTokens: () => bad,
      });
      await assert.rejects(() => runtime.send("hi"), /countPromptTokens must return a non-negative integer/);
    }
  });

  it("behaves as before when no tokenizer is supplied", async () => {
    const { runtime } = makeRuntime("host-none", [{ content: "ok", usage: { inputTokens: 1, outputTokens: 1 } }], { maxContextTokens: 1000 });
    const { budget } = await runtime.send("hi");
    assert.equal(budget.predictedTokens, undefined, "nothing is invented without a counter");
    // The provider's own count is still shown; only the host-count marker is absent.
    assert.match(formatBudget(budget), /令牌 1\/1000\(剩999\)/);
    assert.ok(!formatBudget(budget).includes("(本机)"), "no host-count marker without a tokenizer");
  });

  it("rejects non-positive tool and deadline budgets at construction", () => {
    assert.throws(() => makeRuntime("bad-step", [{ content: "x" }], { maxToolCallsPerStep: 0 }), /positive integer/);
    assert.throws(() => makeRuntime("bad-run", [{ content: "x" }], { maxToolCallsPerRun: 0 }), /positive integer/);
    assert.throws(() => makeRuntime("bad-deadline", [{ content: "x" }], { deadlineMs: 0 }), /positive integer/);
    assert.throws(() => makeRuntime("bad-context", [{ content: "x" }], { maxContextBytes: 0 }), /positive integer/);
    assert.throws(() => makeRuntime("bad-tokens", [{ content: "x" }], { maxContextTokens: 0 }), /positive integer/);
  });

  it("stops when the provider reports more input tokens than the ceiling", async () => {
    // The count comes from the provider's own usage, so this is measured rather
    // than estimated: no tokeniser is bundled and no guess is made.
    const { runtime, adapter } = makeRuntime(
      "token-over",
      [
        { toolCalls: [call("read_file", { path: "hello.txt" })], usage: { inputTokens: 9_000, outputTokens: 5 } },
        { content: "never asked" },
      ],
      { maxContextTokens: 8_000 },
    );

    await assert.rejects(
      () => runtime.send("hello"),
      (error: unknown) => {
        assert.ok(error instanceof TokenBudgetError, "the refusal must be a named budget error");
        assert.equal(error.tokens, 9_000, "it must report the count the provider actually returned");
        assert.equal(error.limit, 8_000);
        assert.match(error.message, /not estimated/);
        return true;
      },
    );
    // One call was spent learning the count; the next must not be spent on a
    // prompt already known to be over the ceiling.
    assert.equal(adapter.consumed, 1, "no further call once the count is known to be over");
  });

  it("has no token measurement on the first call, so only the byte ceiling applies", async () => {
    // Honest limitation, asserted rather than glossed: before any reply there is
    // nothing measured, so a generous token ceiling must not block a first call.
    const { runtime, adapter } = makeRuntime(
      "token-first",
      [{ content: "answered", usage: { inputTokens: 10, outputTokens: 3 } }],
      { maxContextTokens: 8 },
    );
    const result = await runtime.send("hello");
    assert.equal(result.reply.content, "answered", "the first call is bounded by bytes, not by tokens");
    assert.equal(adapter.consumed, 1);
    assert.equal(result.usage.inputTokens, 10);
  });

  it("refuses the next turn once a previous turn was measured over the ceiling", async () => {
    const adapter = createScriptedAdapter({
      steps: [
        { content: "first", usage: { inputTokens: 70_000, outputTokens: 3 } },
        { content: "second", usage: { inputTokens: 999_999, outputTokens: 3 } },
      ],
    });
    const runtime = new AgentRuntime({
      adapter,
      store: new SessionStore({ root: storeRoot }),
      sessionId: "token-carry",
      home,
      workspaceRoot: workspace(),
      tools: makeRegistry(),
      maxContextTokens: 60_000,
    });

    assert.equal((await runtime.send("first")).reply.content, "first");
    // The measurement carries into the next send, and the conversation only grows,
    // so a refusal here needs no extra call and leaves no unanswerable turn.
    await assert.rejects(() => runtime.send("second"), TokenBudgetError);
    assert.equal(adapter.consumed, 1, "the second send must not reach the model");
    const history = await new SessionStore({ root: storeRoot }).history("token-carry");
    assert.deepEqual(
      history.map((message) => `${message.role}:${message.content}`),
      ["user:first", "assistant:first"],
      "the refused turn must not be recorded",
    );
  });

  it("refuses an over-size prompt before calling the model, and leaves no trace", async () => {
    const { runtime, adapter } = makeRuntime("context-over", [{ content: "never reached" }], { maxContextBytes: 64 });

    await assert.rejects(
      () => runtime.send("x".repeat(500)),
      (error: unknown) => {
        assert.ok(error instanceof ContextBudgetError, "the refusal must be a named budget error");
        assert.ok(error.bytes > error.limit, "it must report the observed size and the limit");
        assert.match(error.message, /byte ceiling, not a token count/);
        return true;
      },
    );

    assert.equal(adapter.consumed, 0, "the model must never see an over-size prompt");
    const after = await readFile(new SessionStore({ root: storeRoot }).pathFor("context-over"), "utf8").catch(() => "");
    // The session header may exist (the session is opened first), but the turn
    // itself must not be recorded: it could never be answered, and every later
    // send would fail the same way, leaving the session looking stuck.
    assert.ok(!after.includes('"kind":"message"'), "a refusal must not record a turn that can never be answered");
  });

  it("checks the budget every step, not only at the start", async () => {
    // Sized so the opening prompt fits and the prompt after one tool result does
    // not: fitting at step one proves nothing about step five.
    const { runtime, adapter } = makeRuntime(
      "context-grow",
      [
        { toolCalls: [call("read_file", { path: "hello.txt" })] },
        { content: "done" },
      ],
      { maxContextBytes: 30 },
    );
    await assert.rejects(() => runtime.send("small"), ContextBudgetError);
    assert.equal(adapter.consumed, 1, "the stop must happen after one real step, not before it");

    // Stopping mid-run still leaves a diagnosable session: the issued call has its
    // result recorded, so nothing is dangling and no recovery is owed.
    const store = new SessionStore({ root: storeRoot });
    const { problems } = await store.inspect("context-grow");
    assert.deepEqual(problems, []);
    assert.deepEqual(await store.pendingTools("context-grow"), []);
    await store.assertReady("context-grow");
  });

  it("sends a prompt that fits, unchanged", async () => {
    const { runtime } = makeRuntime(
      "context-fits",
      [
        { toolCalls: [call("read_file", { path: "hello.txt" })] },
        { content: "done" },
      ],
      { maxContextBytes: 800 },
    );
    const result = await runtime.send("small");
    assert.equal(result.reply.content, "done", "a fitting prompt must go through untouched");
  });

  it("surfaces a tool error to the model instead of failing the turn", async () => {
    const { runtime, adapter } = makeRuntime("tool-error", [
      { toolCalls: [call("read_file", { path: "../outside.txt" })] },
      { content: "I could not read that." },
    ]);

    const result = await runtime.send("read outside");
    assert.equal(result.reply.content, "I could not read that.");
    const toolMessage = adapter.requests[1]!.messages.find((message) => message.role === "tool");
    assert.match(toolMessage!.content, /escapes the workspace/);
  });

  it("refuses to persist a completely empty model reply", async () => {
    const { runtime } = makeRuntime("empty-reply", [{ content: "   " }]);
    await assert.rejects(() => runtime.send("hi"), /neither content nor tool calls/);

    // The transcript must not contain a blank assistant turn.
    const history = await runtime.history();
    assert.deepEqual(history.map((message) => message.role), ["user"]);
  });
});

describe("tool events in the session log", () => {
  it("records a tool call once, as the message the next prompt is built from", async () => {
    const { runtime } = makeRuntime("recorded", [
      { toolCalls: [call("read_file", { path: "hello.txt" })] },
      { content: "ok" },
    ]);
    await runtime.send("read it");

    const { events, problems } = await new SessionStore({ root: storeRoot }).inspect("recorded");
    assert.deepEqual(problems, []);

    const kinds = events.map((event) => event.kind);
    assert.deepEqual(kinds, [
      "session",
      "message", // user
      "message", // assistant requesting the tool
      "usage",
      "message", // tool result — the whole record, since ADR-0001
      "message", // assistant answer
      "usage",
    ]);

    const toolEvent = events.find((event) => event.kind === "message" && event.message.role === "tool");
    assert.ok(toolEvent && toolEvent.kind === "message");
    assert.equal(toolEvent.message.toolCallId, "call_1");
    assert.equal(toolEvent.message.content, "file contents here");
    assert.equal(toolEvent.isError, false, "the outcome marker rides on the event, not on ChatMessage");
  });

  it("replays tool calls and results into the reconstructed history", async () => {
    const { runtime } = makeRuntime("replay", [
      { toolCalls: [call("read_file", { path: "hello.txt" })] },
      { content: "ok" },
    ]);
    await runtime.send("read it");

    const history = await new SessionStore({ root: storeRoot }).history("replay");
    assert.deepEqual(
      history.map((message) => message.role),
      ["user", "assistant", "tool", "assistant"],
    );
    assert.equal(history[1]!.toolCalls?.[0]?.name, "read_file");
    assert.equal(history[2]!.toolCallId, "call_1");
    assert.equal(history[3]!.content, "ok");
  });
});

describe("corrupt session lines", () => {
  it("marks new event kinds ignorable so an older reader skips them", () => {
    const skipped = migrateEvent({ v: 1, kind: "future/thing", ignorable: true });
    assert.equal(skipped, null);
  });

  it("still rejects an unknown kind with no ignorable marker", () => {
    assert.throws(() => migrateEvent({ v: 1, kind: "future/thing" }), /unknown event kind/);
  });

  it("reports the offending line number instead of bricking the session", async () => {
    const store = new SessionStore({ root: storeRoot });
    await store.create("corrupt");
    await store.appendMessage("corrupt", { role: "user", content: "before" });
    const { appendFile } = await import("node:fs/promises");
    await appendFile(store.pathFor("corrupt"), "{ this is not json\n", "utf8");
    await assert.rejects(() => store.appendMessage("corrupt", { role: "assistant", content: "must refuse" }), SessionCorruptionError);
    // Construct damaged fixture deliberately; production append must refuse it.
    await appendFile(store.pathFor("corrupt"), JSON.stringify({v:1,kind:"message",at:"t",message:{role:"assistant",content:"after"}})+"\n", "utf8");

    // Strict read names the line.
    await assert.rejects(
      () => store.read("corrupt"),
      (error: unknown) => {
        assert.ok(error instanceof SessionCorruptionError);
        assert.equal(error.line, 3);
        assert.match(error.preview, /this is not json/);
        return true;
      },
    );

    // The salvage path still yields everything else.
    const { events, problems } = await store.inspect("corrupt");
    assert.equal(problems.length, 1);
    assert.equal(problems[0]!.line, 3);
    assert.deepEqual(
      events.filter((event) => event.kind === "message").map((event) => event.kind),
      ["message", "message"],
    );
    // History still goes through the strict path, so it fails loudly rather
    // than silently returning a history with a turn missing.
    await assert.rejects(() => store.history("corrupt"), SessionCorruptionError);
  });

  it("reports a structurally invalid but parseable line", async () => {
    const store = new SessionStore({ root: storeRoot });
    await store.create("shape");
    const { appendFile } = await import("node:fs/promises");
    // `content` must be a string; a number is a shape violation, not a syntax one.
    await appendFile(store.pathFor("shape"), '{"v":1,"kind":"message","at":"t","message":{"role":"user","content":5}}\n', "utf8");

    const { problems } = await store.inspect("shape");
    assert.equal(problems.length, 1);
    assert.match(problems[0]!.detail, /content must be a string/);
  });

  it("reads a healthy session with no problems", async () => {
    const { runtime } = makeRuntime("healthy", [{ content: "fine" }]);
    await runtime.send("hi");
    const { problems } = await new SessionStore({ root: storeRoot }).inspect("healthy");
    assert.deepEqual(problems, []);
  });
});
