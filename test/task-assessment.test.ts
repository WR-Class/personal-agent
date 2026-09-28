/**
 * The round-end assessment: what the system concludes about the task from what the
 * round mechanically did.
 *
 * The two load-bearing assertions here are negatives, and both exist because the
 * obvious implementation is wrong:
 *
 * - A cross-round task must NOT be graded by one round's evidence. A step met in
 *   round two reads as unmet against round five's evidence, so folding this into
 *   `evaluation.status` would have the system manufacturing a misleading verdict
 *   about itself — the shape D62 refused to inject into the prompt.
 * - The assessment must NOT reach the next prompt, for the same reason from the
 *   other direction.
 *
 * Both are the same asymmetry (per-round evidence, cross-round task) showing up at
 * the two ends of the round.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { AgentRuntime } from "../src/runtime.ts";
import { SessionStore } from "../src/session-store.ts";
import { ToolRegistry, createCreateFileTool, createReadFileTool } from "../src/tools.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { createTestFixture } from "./fixtures.ts";
import { formatTaskAssessment } from "../src/task-state.ts";
import type { GeneValidation } from "../src/gene.ts";

const fixture = await createTestFixture("task-assessment");
const home = fixture.storeRoot;
const workspaceRoot = fixture.workspaceRoot;
const SYSTEM = "You are a concise assistant.";
const MARKER = "把 provider 配置改成可切换的";

let created = 0;
const written = (paths: string[]): GeneValidation => ({ kind: "files-written", paths });

async function round(
  steps: unknown[],
  taskState?: { state: string; steps: { text: string; claim?: GeneValidation }[] },
) {
  const sessionId = `assess-${created++}`;
  const store = new SessionStore({ root: home });
  await store.create(sessionId);
  if (taskState !== undefined) await store.appendTaskState(sessionId, taskState);
  const agent = new AgentRuntime({
    adapter: createScriptedAdapter({ steps: steps as never, model: "assess-model" }),
    store,
    sessionId,
    home,
    workspaceRoot,
    tools: new ToolRegistry([createReadFileTool(), createCreateFileTool()], ["read_file", "create_file"]),
    systemPrompt: SYSTEM,
    approve: async () => true,
  });
  return { result: await agent.send("开始"), store, sessionId, agent };
}

const writeFile = (path: string, content: string) => ({
  toolCalls: [{ id: `c-${Math.random().toString(36).slice(2)}`, name: "create_file", arguments: JSON.stringify({ path, content }) }],
});

describe("the assessment is scoped to the round and never gates it", () => {
  it("reports a step this round's evidence satisfies, and complete with it", async () => {
    const { result } = await round(
      [writeFile("a.txt", "x"), { content: "写好了" }],
      { state: MARKER, steps: [{ text: "写 a.txt", claim: written(["a.txt"]) }] },
    );
    assert.notEqual(result.taskAssessment, undefined, "a recorded state is assessed");
    assert.equal(result.taskAssessment!.complete, true, "this round alone satisfied every step");
    assert.deepEqual(result.taskAssessment!.steps[0]!.outcome, "met");
    // Same ledger, two readers: the budget line and the assessment must not disagree
    // about what the round wrote, which is why one named evidence object feeds both.
    assert.equal(result.budget.filesWritten, 1);
  });

  it("does NOT downgrade the round when an earlier round is what satisfied a step", async () => {
    // The load-bearing one. Round two writes nothing, so the step reads unmet
    // against round two's evidence — while having been met in round one.
    // Its own filename: create_file does not overwrite, and every test here shares
    // one workspace, so reusing a name makes the second write fail and the ledger
    // stay empty — the assertion would then be testing nothing.
    const taskState = { state: MARKER, steps: [{ text: "写 b.txt", claim: written(["b.txt"]) }] };
    const first = await round([writeFile("b.txt", "x"), { content: "写好了" }], taskState);
    assert.equal(first.result.taskAssessment!.complete, true, "round one really did satisfy it");

    // Same scripted round, once with a task state recorded and once without. If the
    // assessment gated anything, these two verdicts would differ.
    const withState = await round([{ content: "没有再写文件" }], taskState);
    const withoutState = await round([{ content: "没有再写文件" }]);
    assert.equal(withState.result.taskAssessment!.complete, false);
    assert.deepEqual(withState.result.taskAssessment!.steps[0]!.outcome, "unmet");
    assert.deepEqual(
      withState.result.evaluation,
      withoutState.result.evaluation,
      "the round's verdict must be byte-identical whether or not a task state exists",
    );
  });

  it("is absent when no task state was ever recorded, rather than an empty verdict", async () => {
    const { result } = await round([{ content: "随便说说" }]);
    assert.equal(result.taskAssessment, undefined);
  });

  it("puts a step with no criterion in unknowns, not in failed", async () => {
    const { result } = await round([{ content: "做了一点" }], {
      state: MARKER,
      steps: [{ text: "还没有验收条件的一步" }],
    });
    assert.equal(result.taskAssessment!.failed.length, 0, "nothing was contradicted");
    assert.equal(result.taskAssessment!.unknowns.length, 1);
    assert.match(result.taskAssessment!.unknowns[0]!, /缺验收条件/);
    assert.equal(result.taskAssessment!.complete, false, "an unknown is not completion");
  });

  it("keeps a command criterion unverifiable, and says so out loud", async () => {
    const { result } = await round([{ content: "跑过了" }], {
      state: MARKER,
      steps: [{ text: "跑测试", claim: { kind: "command", command: "npm.cmd test" } }],
    });
    assert.deepEqual(result.taskAssessment!.steps[0]!.outcome, "unverifiable");
    assert.equal(result.taskAssessment!.failed.length, 0, "undecidable is not contradicted");
    assert.equal(result.taskAssessment!.complete, false);
    const line = formatTaskAssessment(result.taskAssessment!)!;
    // The ceiling has to be restated wherever the assessment is shown, because a
    // reader who forgets it will read "unverifiable" as "not done".
    assert.match(line, /判不了不等于没做/);
    assert.match(line, /恒为 unverifiable/);
  });
});

describe("the rendering is scoped, because the step strings are not", () => {
  it("states the round scope and never asserts completion without it", () => {
    const assessment = {
      steps: [{ text: "一", outcome: "met" as const }, { text: "二", outcome: "unmet" as const, detail: "x" }],
      complete: false,
      unknowns: [],
      failed: ["步骤 2（二） 未达成：x"],
    };
    const line = formatTaskAssessment(assessment)!;
    assert.match(line, /本轮任务判定/, "the line names its own scope");
    assert.match(line, /仅对本轮证据/, "and says what that scope is");
    assert.match(line, /不代表从未达成/, "and forecloses the wrong reading");
    assert.match(line, /1\/2 步达成/);
    assert.match(line, /本轮未达成 1/, "the count is scoped too, not just the header");
  });

  it("omits counts that are zero rather than printing a reassuring 0", () => {
    const line = formatTaskAssessment({
      steps: [{ text: "一", outcome: "met" as const }],
      complete: true,
      unknowns: [],
      failed: [],
    })!;
    assert.match(line, /1\/1 步达成/);
    assert.ok(!line.includes("未知"), "no unknowns, so no unknown count");
    assert.ok(!line.includes("本轮未达成"), "nothing failed, so no failed count");
  });

  it("renders nothing for an empty assessment", () => {
    assert.equal(formatTaskAssessment({ steps: [], complete: false, unknowns: [], failed: [] }), undefined);
  });
});

describe("the assessment never reaches the model", () => {
  it("is absent from the next prompt, which is D62's invariant surviving this change", async () => {
    // Wiring the assessment in at round end is exactly the change that would make
    // injecting it tempting: the value is now sitting right there. It must stay out,
    // because round five would report round two's work as never done.
    const { result, agent } = await round(
      [writeFile("c.txt", "x"), { content: "写好了" }, { content: "第二轮" }],
      { state: MARKER, steps: [{ text: "写 c.txt", claim: written(["c.txt"]) }, { text: "还没做的一步", claim: written(["zz.txt"]) }] },
    );
    assert.notEqual(result.taskAssessment, undefined);
    assert.deepEqual(result.taskAssessment!.steps[0]!.outcome, "met", "the write really happened, so this test means what it says");
    const second = await agent.send("继续");
    const text = second.history[0]!.content;
    assert.ok(text.startsWith(SYSTEM), "the system prompt is still the product's own text first");
    for (const forbidden of ["本轮任务判定", "仅对本轮证据", "步达成", "未达成：", "无法判定：", "判不了不等于没做"]) {
      assert.ok(!text.includes(forbidden), `the prompt must not carry the assessment: found "${forbidden}"`);
    }
    // The state block itself is still injected — that is D62's design, and this
    // round must not have disturbed it.
    assert.ok(text.includes(MARKER), "the recorded state is still re-injected");
    assert.ok(text.includes("files-written:[c.txt]"), "with its criteria");
  });
});
