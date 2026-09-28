/**
 * The mechanical verdict, rendered where an operator can see it.
 *
 * The defect this closes is not a missing feature but an invisible one: the
 * verdict was computed every round, stored in the cycle journal, carried on
 * `SendResult.evaluation` — and never printed. "Trust only mechanical facts" held
 * in the log and nowhere the operator looked.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { evaluateRun, formatEvaluation } from "../src/cycle.ts";
import type { CycleEvaluation } from "../src/cycle.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { SessionStore } from "../src/session-store.ts";
import { ToolRegistry, createReadFileTool } from "../src/tools.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { createTestFixture } from "./fixtures.ts";

const fixture = await createTestFixture("format-evaluation");

const evaluation = (overrides: Partial<CycleEvaluation> = {}): CycleEvaluation => ({
  status: "success",
  failureClass: null,
  evidence: ["steps=1", "toolCalls=0", "toolErrors=0"],
  reviewer: "mechanical",
  ...overrides,
});

/** The indented evidence lines, excluding the omission note. */
function shownEvidence(block: string): string[] {
  return block.split("\n").slice(1).filter((line) => line.startsWith("  ") && !line.includes("条证据未显示"));
}

describe("the verdict line", () => {
  it("names the status and who judged it", () => {
    const block = formatEvaluation(evaluation());
    const head = block.split("\n")[0]!;
    assert.match(head, /^\[本轮判定 success · 判定者 mechanical\]$/);
    // `reviewer` is not decoration: the field exists to say who judged, and the day
    // a reviewer that is not the worker appears, this is the only place the
    // difference would be visible.
    assert.match(head, /判定者 mechanical/);
  });

  it("drops evidence the budget line already states, and keeps the one it does not", () => {
    const block = formatEvaluation(evaluation());
    const shown = shownEvidence(block).map((line) => line.trim());
    assert.ok(!shown.some((line) => line.startsWith("steps=")), "the budget line already prints 步骤 N/M");
    assert.ok(!shown.some((line) => line.startsWith("toolCalls=")), "and already prints 工具 N/M");
    assert.deepEqual(shown, ["toolErrors=0"], "failures are not on the budget line, so they stay");
  });

  it("shows a gene's claim outcomes, which is the gap this round closes", () => {
    // validationEvidence already folds claims into `evidence`, so one renderer
    // covers both. Rendering `validation` separately would be a second
    // presentation of one fact, and the two would drift.
    const block = formatEvaluation(
      evaluation({
        evidence: [
          "steps=2",
          "toolCalls=1",
          "toolErrors=0",
          "validation:met=files-written:src/a.ts (wrote exactly the claimed paths)",
          "validation:unmet=tool-used:create_file>=2 (used 1 time)",
          "validation:unverifiable=command:npm.cmd test (no shell exists yet)",
        ],
      }),
    );
    const shown = shownEvidence(block).map((line) => line.trim());
    assert.deepEqual(shown, [
      "toolErrors=0",
      "validation:met=files-written:src/a.ts (wrote exactly the claimed paths)",
      "validation:unmet=tool-used:create_file>=2 (used 1 time)",
      "validation:unverifiable=command:npm.cmd test (no shell exists yet)",
    ]);
    assert.match(block, /unmet/, "a contradicted claim is visible, not summarized away");
    assert.match(block, /unverifiable/, "and so is one that could not be decided");
  });

  it("says why it failed, when it failed for a classifiable reason", () => {
    const head = formatEvaluation(evaluation({ status: "failed", failureClass: "budget" })).split("\n")[0]!;
    assert.match(head, /本轮判定 failed · 判定者 mechanical · 原因 budget/);
  });

  it("keeps blocked and failed distinguishable", () => {
    // evaluateRun's own rule: a model that never produced anything usable means the
    // round could not start, which is not the same as a round that started and broke.
    const blocked = evaluateRun({ steps: 0, toolCalls: 0, toolErrors: 0, failureClass: "model" });
    const failed = evaluateRun({ steps: 3, toolCalls: 2, toolErrors: 1, failureClass: "model" });
    assert.equal(blocked.status, "blocked");
    assert.equal(failed.status, "failed");
    assert.match(formatEvaluation(blocked), /本轮判定 blocked/);
    assert.match(formatEvaluation(failed), /本轮判定 failed/);
    assert.notEqual(formatEvaluation(blocked).split("\n")[0], formatEvaluation(failed).split("\n")[0]);
  });

  it("counts what it withheld instead of truncating quietly", () => {
    const many = Array.from({ length: 20 }, (_, index) => `validation:met=no-write (claim ${index})`);
    const block = formatEvaluation(evaluation({ evidence: ["steps=1", "toolCalls=0", ...many] }));
    const shown = shownEvidence(block);
    assert.ok(shown.length < many.length, "the cap actually applies");
    assert.match(block, new RegExp(`另有 ${many.length - shown.length} 条证据未显示`), "and reports the exact number withheld");
  });

  it("omits the note entirely when nothing was withheld", () => {
    assert.ok(!formatEvaluation(evaluation()).includes("条证据未显示"));
  });

  it("renders a partial round as partial, which is what a tool error produces", () => {
    const partial = evaluateRun({ steps: 2, toolCalls: 3, toolErrors: 1, failureClass: null });
    assert.equal(partial.status, "partial");
    const block = formatEvaluation(partial);
    assert.match(block, /本轮判定 partial/);
    assert.match(block, /toolErrors=1/, "the fact the verdict was read off is shown with it");
  });
});

describe("it is wired to a real round, not to a hand-built object", () => {
  it("renders the verdict an actual send produced", async () => {
    const sessionId = `verdict-${Date.now()}`;
    const store = new SessionStore({ root: fixture.storeRoot });
    const agent = new AgentRuntime({
      adapter: createScriptedAdapter({ steps: [{ content: "做完了" }], model: "verdict-model" }),
      store,
      sessionId,
      home: fixture.storeRoot,
      workspaceRoot: fixture.workspaceRoot,
      tools: new ToolRegistry([createReadFileTool()], ["read_file"]),
      systemPrompt: "You are a concise assistant.",
    });
    const result = await agent.send("开始");
    const block = formatEvaluation(result.evaluation);
    assert.match(block, /本轮判定 (success|partial|failed|blocked)/);
    assert.match(block, /判定者 mechanical/);
    assert.match(block, /toolErrors=/);
    // The verdict must agree with what the round mechanically did: no tools ran, so
    // nothing errored, so it is a success — read off the facts, never self-reported.
    assert.equal(result.evaluation.status, "success");
    assert.equal(result.toolCalls, 0);
  });
});
