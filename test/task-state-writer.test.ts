/**
 * The task-state writer, under the same two gates as every other write.
 *
 * D60 named this the largest risk in the whole feature: appending task state does
 * not go through the file tools, so neither the agent-home location denial nor the
 * write budget would reach it by default — yet it changes what every later prompt
 * tells the model. So the load-bearing assertions here are about gate coverage,
 * not about the tool working.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { SessionStore } from "../src/session-store.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { ToolRegistry, createReadFileTool, createUpdateTaskStateTool } from "../src/tools.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { createTestFixture } from "./fixtures.ts";
import { findTier } from "../src/tiers.ts";
import { decide } from "../src/rule-table.ts";
import { READ_ONLY_TOOLS, WRITE_TOOLS } from "../src/write-tools.ts";
import { DEFAULT_RULES } from "../src/file-policy.ts";
import { chargeWrite, checkWrite, isWriteTool, readWriteAttempt } from "../src/write-budget.ts";
import type { GeneValidation } from "../src/gene.ts";

const fixture = await createTestFixture("task-state-writer");
const home = fixture.storeRoot;
const workspaceRoot = fixture.workspaceRoot;
const SYSTEM = "You are a concise assistant.";
const MARKER = "把 provider 配置改成可切换的";

let created = 0;
function setup(): { store: SessionStore; sessionId: string; tool: ReturnType<typeof createUpdateTaskStateTool> } {
  const sessionId = `writer-${created++}`;
  const store = new SessionStore({ root: home });
  return { store, sessionId, tool: createUpdateTaskStateTool(store, sessionId) };
}

const context = { workspaceRoot, approve: async () => true };
const call = (args: unknown) => ({ id: "call-1", name: "update_task_state", arguments: JSON.stringify(args) });
const used = (tool: string, times?: number): GeneValidation =>
  times === undefined ? { kind: "tool-used", tool } : { kind: "tool-used", tool, times };

describe("gate coverage: offered and allowed must agree", () => {
  it("is a write tool, so both derived tables see it", () => {
    assert.ok(WRITE_TOOLS.includes("update_task_state"));
    assert.ok(!READ_ONLY_TOOLS.includes("update_task_state"));
    assert.equal(isWriteTool("update_task_state"), true, "the budget's table and the tier's table must not drift");
  });

  it("is absent from a read-only posture, in both mechanisms", async () => {
    // The defect write-tools.ts records actually happening: a tool offered by a
    // tier but denied by the rule table, so the model was handed something it
    // could never call. Absence has to hold in both directions.
    const tier = findTier("read-only")!;
    assert.ok(!tier.tools.includes("update_task_state"), "a read-only posture does not offer it");
    assert.notEqual(decide(tier.rules, "update_task_state", {}).decision, "allow", "and does not allow it");
    const registry = new ToolRegistry([createReadFileTool()], tier.tools.filter((name) => name === "read_file"));
    const result = await registry.execute(call({ state: MARKER, steps: [] }), context);
    assert.equal(result.isError, true);
    assert.match(result.content, /unknown tool|not offered|unknown/i);
  });

  it("is treated exactly like another write, under both the defaults and a tier", () => {
    const tier = findTier("full-access")!;
    assert.ok(tier.tools.includes("update_task_state"), "offered by a write-capable posture");
    // The load-bearing property is "no carve-out". Were this tool quietly exempted
    // from asking, it would be the one tool that reshapes what every later prompt
    // tells the model without the operator ever seeing it. Asserting equality with
    // `run_command` rather than a hardcoded decision is what makes a future
    // exception fail this test instead of passing silently.
    for (const rules of [DEFAULT_RULES, tier.rules]) {
      assert.equal(
        decide(rules, "update_task_state", {}).decision,
        decide(rules, "run_command", {}).decision,
        "same decision as run_command under the same rules",
      );
    }
    // Pinned explicitly because it is counter-intuitive, and an earlier draft of
    // this test asserted the wrong half of it: DEFAULT_RULES say `approve`, and the
    // full-access tier overrides that to `allow`. A higher RULE_TIER always
    // outranks a lower one whatever the priority, so a write-capable posture does
    // not prompt for writes — the usability worry behind "should this ask at all"
    // was about a posture that does not exist.
    assert.equal(decide(DEFAULT_RULES, "update_task_state", {}).decision, "approve");
    assert.equal(decide(tier.rules, "update_task_state", {}).decision, "allow");
  });

  it("consumes a write-budget slot without consuming line budget", () => {
    // Null line argument, like run_command and job_kill: it writes no file, so
    // there are no lines of code to count, and charging lines would misreport what
    // the budget measures. The slot is the honest charge — one write happened.
    const attempt = readWriteAttempt("update_task_state", JSON.stringify({ state: MARKER, steps: [] }));
    assert.notEqual(attempt, null);
    assert.equal(attempt!.path, null, "it names no file path");
    assert.equal(attempt!.lines, null, "so there are no lines to charge");
    const budget = { maxFiles: 2, maxLines: 10 };
    assert.equal(checkWrite({ files: [], lines: 0 }, attempt!, budget).allowed, true);
    const charged = chargeWrite({ files: [], lines: 0 }, attempt!, 0);
    assert.equal(charged.files.length, 1, "it occupies an anonymous slot");
    assert.equal(charged.lines, 0, "and charges no lines");
    // A second one is a second slot, not a free repeat.
    assert.equal(checkWrite(charged, attempt!, budget).allowed, true);
    const twice = chargeWrite(charged, attempt!, 1);
    assert.equal(twice.files.length, 2);
    assert.equal(checkWrite(twice, attempt!, budget).allowed, false, "until the file budget is exhausted");
  });

  it("treats unparseable arguments as a write of unknown extent, not as a free one", () => {
    const attempt = readWriteAttempt("update_task_state", "{not json");
    assert.notEqual(attempt, null);
    assert.equal(attempt!.path, null);
    assert.equal(attempt!.lines, null);
  });
});

describe("the writer tool", () => {
  it("records state and reports no step as done", async () => {
    const { store, sessionId, tool } = setup();
    await store.create(sessionId);
    const registry = new ToolRegistry([tool], ["update_task_state"]);
    const result = await registry.execute(
      call({ state: MARKER, steps: [{ text: "改配置", claim: { kind: "files-written", paths: ["src/provider.ts"] } }] }),
      context,
    );
    assert.notEqual(result.isError, true, result.content);
    // The tool has no authority to declare completion, so it must not sound like it
    // did. Saying "done" here would be the self-report channel the design closes.
    assert.match(result.content, /does not report any step as done|reports no step as done/);
    assert.ok(!/已完成|已达成|completed successfully/.test(result.content));
    const recorded = await store.taskState(sessionId);
    assert.equal(recorded?.state, MARKER);
    assert.deepEqual(recorded?.steps[0]!.claim, { kind: "files-written", paths: ["src/provider.ts"] });
  });

  it("writes no audit record when the write was accepted", async () => {
    // The accepted write is itself a record in the log. Auditing it too would keep
    // two accounts of one fact — the shape ADR-0001 exists to prevent.
    const { store, sessionId, tool } = setup();
    await store.create(sessionId);
    const registry = new ToolRegistry([tool], ["update_task_state"]);
    await registry.execute(call({ state: MARKER, steps: [] }), context);
    const audits = (await store.read(sessionId)).filter((event) => event.kind === "audit");
    assert.deepEqual(audits, []);
  });

  it("refuses and audits an attempt to lower a criterion", async () => {
    // A refusal leaves no other trace, and "who tried to move the bar, and when" is
    // exactly what AuditEvent says it exists to answer.
    const { store, sessionId, tool } = setup();
    await store.create(sessionId);
    const registry = new ToolRegistry([tool], ["update_task_state"]);
    await registry.execute(call({ state: MARKER, steps: [{ text: "调用两次", claim: used("create_file", 2) }] }), context);
    const result = await registry.execute(
      call({ state: MARKER, steps: [{ text: "调用两次", claim: used("create_file", 1) }] }),
      context,
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /次数下限从 2 降到了 1/);
    const latest = await store.taskState(sessionId);
    assert.deepEqual(latest?.steps[0]!.claim, used("create_file", 2), "the bar did not move");
    const audits = (await store.read(sessionId)).filter((event) => event.kind === "audit") as
      { tool: string; decision: string; reason: string }[];
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.tool, "update_task_state");
    assert.equal(audits[0]!.decision, "denied");
    assert.match(audits[0]!.reason, /次数下限从 2 降到了 1/);
  });

  it("refuses a deleted step, which would drop its criterion", async () => {
    const { store, sessionId, tool } = setup();
    await store.create(sessionId);
    const registry = new ToolRegistry([tool], ["update_task_state"]);
    await registry.execute(
      call({ state: MARKER, steps: [{ text: "一", claim: used("read_file") }, { text: "二", claim: used("create_file") }] }),
      context,
    );
    const result = await registry.execute(call({ state: MARKER, steps: [{ text: "一", claim: used("read_file") }] }), context);
    assert.equal(result.isError, true);
    assert.match(result.content, /删除步骤/);
    assert.equal((await store.taskState(sessionId))?.steps.length, 2);
  });

  it("refuses every malformed call, names a position, and stores nothing", async () => {
    const { store, sessionId, tool } = setup();
    await store.create(sessionId);
    const registry = new ToolRegistry([tool], ["update_task_state"]);
    const malformed: unknown[] = [
      { steps: [] },
      { state: "  ", steps: [] },
      { state: MARKER },
      { state: MARKER, steps: "nope" },
      { state: MARKER, steps: [null] },
      { state: MARKER, steps: [{ text: "" }] },
      { state: MARKER, steps: [{ text: "一", claim: 7 }] },
      { state: MARKER, steps: [{ text: "一", claim: { kind: "invented" } }] },
      { state: MARKER, steps: [{ text: "一", claim: { kind: "tool-used" } }] },
    ];
    for (const args of malformed) {
      const result = await registry.execute(call(args), context);
      assert.equal(result.isError, true, `expected refusal for ${JSON.stringify(args)}`);
      // Two layers can refuse, and which one fires is an implementation detail:
      // the registry validates against the JSON Schema first (`$.steps[0].claim
      // must be object`), and parseTaskStateArguments then validates claim
      // semantics the Schema cannot express. What is NOT an implementation detail
      // is that the message names a position — a bare "invalid arguments" leaves
      // the model nothing to correct, so it would just retry the same call.
      assert.match(result.content, /state|steps/, `message for ${JSON.stringify(args)} was: ${result.content}`);
    }
    // The one refusal worth pinning exactly, because it is the one the Schema
    // cannot make: an invented claim kind. Guessing what the writer meant would be
    // the kind of inference this project refuses (D20), so the valid vocabulary is
    // spelled out for the model instead.
    const invented = await registry.execute(
      call({ state: MARKER, steps: [{ text: "一", claim: { kind: "invented" } }] }),
      context,
    );
    assert.match(invented.content, /must be one of: files-written, no-write, tool-used, command/);
    assert.equal(await store.taskState(sessionId), undefined, "no malformed call left anything behind");
  });

  it("refuses a bare-string criterion, so an unverifiable claim cannot arrive by accident", async () => {
    // `parseValidation` accepts a bare string and reads it as a hand-written
    // command (D20), which suits a gene file a person typed. This tool's schema
    // deliberately does not, and the reason is concrete rather than stylistic: a
    // bare string silently becomes a `command` claim, and a `command` claim is
    // *permanently unverifiable* in this runtime — nothing here runs shells. So
    // `claim: "跑测试"` would produce a criterion that can never be decided, with
    // the consequence invisible at the call site. Requiring the explicit
    // `{kind:"command", command:"..."}` object makes the writer name the thing that
    // cannot be checked. One accepted shape is also one way to be wrong.
    const { store, sessionId, tool } = setup();
    await store.create(sessionId);
    const registry = new ToolRegistry([tool], ["update_task_state"]);
    const result = await registry.execute(call({ state: MARKER, steps: [{ text: "跑测试", claim: "npm.cmd test" }] }), context);
    assert.equal(result.isError, true);
    assert.match(result.content, /claim must be object/);
    assert.equal(await store.taskState(sessionId), undefined);
    // The explicit object form is accepted and stored verbatim, still unverifiable.
    const explicit = await registry.execute(
      call({ state: MARKER, steps: [{ text: "跑测试", claim: { kind: "command", command: "npm.cmd test" } }] }),
      context,
    );
    assert.notEqual(explicit.isError, true, explicit.content);
    assert.deepEqual((await store.taskState(sessionId))?.steps[0]!.claim, { kind: "command", command: "npm.cmd test" });
  });

  it("asks before recording, and records nothing when the operator says no", async () => {
    const { store, sessionId, tool } = setup();
    await store.create(sessionId);
    const registry = new ToolRegistry([tool], ["update_task_state"]);
    let asked = 0;
    const result = await registry.execute(call({ state: MARKER, steps: [] }), {
      workspaceRoot,
      approve: async () => {
        asked += 1;
        return false;
      },
    });
    assert.equal(asked, 1, "the operator is asked, as for any other write");
    assert.equal(result.isError, true);
    assert.equal(await store.taskState(sessionId), undefined);
  });

  it("reaches the next prompt, which is the whole point of the tool", async () => {
    const { store, sessionId, tool } = setup();
    const adapter = createScriptedAdapter({
      steps: [
        { toolCalls: [{ id: "c1", name: "update_task_state", arguments: JSON.stringify({ state: MARKER, steps: [{ text: "改配置", claim: { kind: "files-written", paths: ["src/provider.ts"] } }] }) }] },
        { content: "已记录" },
        { content: "第二轮" },
      ],
      model: "writer-model",
    });
    const agent = new AgentRuntime({
      adapter,
      store,
      sessionId,
      home,
      workspaceRoot,
      tools: new ToolRegistry([tool, createReadFileTool()], ["update_task_state", "read_file"]),
      systemPrompt: SYSTEM,
      approve: async () => true,
    });
    await agent.send("开始");
    assert.notEqual(await store.taskState(sessionId), undefined, "the tool call actually wrote");
    const second = await agent.send("继续");
    const text = second.history[0]!.content;
    assert.ok(text.startsWith(SYSTEM), "the state rides behind the product's own text");
    assert.ok(text.includes(MARKER), "the model sees the state it recorded");
    assert.ok(text.includes("files-written:[src/provider.ts]"), "and sees the criterion, which is what monotonicity protects");
  });
});
