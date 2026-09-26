import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { CycleError, applyEvent, evaluateRun, isTerminal, replay, startCycle } from "../src/cycle.ts";
import type { CycleEvent, CycleEvaluation } from "../src/cycle.ts";
import { CycleStore } from "../src/cycle-store.ts";
import { GeneStore } from "../src/gene-store.ts";
import { mintGene } from "../src/gene.ts";
import type { Gene } from "../src/gene.ts";
import { SessionStore } from "../src/session-store.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { ToolRegistry, createReadFileTool } from "../src/tools.ts";
import { createEchoAdapter, createScriptedAdapter } from "../src/echo-adapter.ts";
import { createTestFixture } from "./fixtures.ts";
import type { ToolCall } from "../src/types.ts";

let fixture: Awaited<ReturnType<typeof createTestFixture>>;

before(async () => {
  fixture = await createTestFixture("cycle");
});

const T0 = 1_700_000_000_000;
const OK: CycleEvaluation = { status: "success", failureClass: null, evidence: ["steps=1"], reviewer: "mechanical" };
const BAD: CycleEvaluation = { status: "failed", failureClass: "unknown", evidence: ["steps=0"], reviewer: "mechanical" };

function call(name: string, args: Record<string, unknown>, id = "call_1"): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

function gene(overrides: Partial<Gene> = {}): Gene {
  return {
    name: "loop-discipline",
    intent: "build",
    signalsMatch: ["snippet"],
    preconditions: [],
    strategy: [
      { kind: "guard", text: "read first" },
      { kind: "act", text: "minimal edit" },
      { kind: "verify", text: "re-read" },
    ],
    constraints: { maxFiles: 1, maxLines: 20, forbiddenPaths: [] },
    validation: ["npm.cmd test"],
    avoid: [],
    ...overrides,
  };
}

describe("PDRI state machine", () => {
  it("walks planned to completed through the documented phases", () => {
    let state = startCycle("c1", T0);
    assert.equal(state.phase, "planned");
    const events: CycleEvent[] = [
      { type: "execute-start", at: T0 + 1 },
      { type: "review-ready", at: T0 + 2, evaluation: OK },
      { type: "integrate-ready", at: T0 + 3 },
      { type: "complete", at: T0 + 4 },
    ];
    for (const event of events) state = applyEvent(state, event);
    assert.equal(state.phase, "completed");
    assert.equal(state.evaluation?.status, "success");
    assert.ok(isTerminal(state.phase));
    assert.deepEqual(replay("c1", T0, events), state);
  });

  it("refuses to integrate a review that failed", () => {
    let state = startCycle("c2", T0);
    state = applyEvent(state, { type: "execute-start", at: T0 + 1 });
    state = applyEvent(state, { type: "review-ready", at: T0 + 2, evaluation: BAD });
    assert.throws(() => applyEvent(state, { type: "integrate-ready", at: T0 + 3 }), /cannot integrate a failed review/);
  });

  it("refuses phases out of order and any event after a terminal phase", () => {
    assert.throws(() => applyEvent(startCycle("c3", T0), { type: "complete", at: T0 + 1 }), /requires integrating/);
    const done = applyEvent(
      applyEvent(
        applyEvent(applyEvent(startCycle("c4", T0), { type: "execute-start", at: T0 + 1 }),
          { type: "review-ready", at: T0 + 2, evaluation: OK }),
        { type: "integrate-ready", at: T0 + 3 }),
      { type: "complete", at: T0 + 4 });
    assert.throws(() => applyEvent(done, { type: "fail", at: T0 + 5, evaluation: BAD }), CycleError);
  });

  it("closes an interrupted round as failed, and a cancellation as cancelled", () => {
    const running = applyEvent(startCycle("c5", T0), { type: "execute-start", at: T0 + 1 });
    assert.equal(applyEvent(running, { type: "fail", at: T0 + 2, evaluation: BAD }).phase, "failed");
    const cancelled: CycleEvaluation = { status: "failed", failureClass: "cancelled", evidence: [], reviewer: "mechanical" };
    assert.equal(applyEvent(running, { type: "fail", at: T0 + 2, evaluation: cancelled }).phase, "cancelled");
  });
});

describe("mechanical evaluation", () => {
  it("reads a verdict off facts, never off a self-report", () => {
    assert.equal(evaluateRun({ steps: 1, toolCalls: 0, toolErrors: 0, failureClass: null }).status, "success");
    const partial = evaluateRun({ steps: 3, toolCalls: 2, toolErrors: 1, failureClass: null });
    assert.equal(partial.status, "partial");
    assert.deepEqual(partial.evidence, ["steps=3", "toolCalls=2", "toolErrors=1"]);
    assert.equal(evaluateRun({ steps: 0, toolCalls: 0, toolErrors: 0, failureClass: "budget" }).status, "failed");
    // A model that never produced a usable reply blocked the round; one that did
    // and then broke is a failure.
    assert.equal(evaluateRun({ steps: 0, toolCalls: 0, toolErrors: 0, failureClass: "model" }).status, "blocked");
    assert.equal(evaluateRun({ steps: 1, toolCalls: 0, toolErrors: 0, failureClass: "model" }).status, "failed");
  });
});

describe("cycle store", () => {
  it("folds events back into the same state, and survives a reload", async () => {
    const path = join(fixture.root, "cycles.jsonl");
    const store = new CycleStore(path);
    await store.append("s1", "c1", { type: "execute-start", at: T0 + 1 }, T0);
    await store.append("s1", "c1", { type: "review-ready", at: T0 + 2, evaluation: OK }, T0 + 2);
    await store.append("s1", "c1", { type: "integrate-ready", at: T0 + 3 }, T0 + 3);
    await store.append("s1", "c1", { type: "complete", at: T0 + 4 }, T0 + 4);
    for (const reopened of [store, new CycleStore(path)]) {
      const states = await reopened.states();
      assert.equal(states.get("c1")?.phase, "completed");
      assert.equal(states.get("c1")?.evaluation?.status, "success");
    }
  });

  it("keeps an unclosed cycle visibly unfinished", async () => {
    const store = new CycleStore(join(fixture.root, "open.jsonl"));
    await store.append("s1", "c9", { type: "execute-start", at: T0 + 1 }, T0);
    assert.equal((await store.states()).get("c9")?.phase, "executing");
  });

  it("tolerates a truncated tail and refuses a malformed middle line", async () => {
    const path = join(fixture.root, "cycles-corrupt.jsonl");
    const store = new CycleStore(path);
    await store.append("s1", "c1", { type: "execute-start", at: T0 + 1 }, T0);
    const good = await readFile(path, "utf8");
    await writeFile(path, `${good}{"schema":1,"type":"cycle"`, "utf8");
    assert.equal((await new CycleStore(path).states()).get("c1")?.phase, "executing");
    await writeFile(path, `${good}{"schema":9,"type":"cycle"}\n`, "utf8");
    await assert.rejects(() => new CycleStore(path).states(), /line 2/);
  });

  it("reads an absent journal as empty", async () => {
    assert.equal((await new CycleStore(join(fixture.root, "missing.jsonl")).states()).size, 0);
  });
});

describe("runtime runs a PDRI cycle", () => {
  const options = (sessionId: string, geneStore: GeneStore, cycleStore: CycleStore, adapter = createEchoAdapter()) => ({
    adapter, store: new SessionStore({ root: fixture.storeRoot }), sessionId,
    home: fixture.home, workspaceRoot: fixture.workspaceRoot, geneStore, cycleStore,
  });

  it("completes a round, journals every phase, and records the verdict", async () => {
    const geneStore = new GeneStore(join(fixture.root, "e2e-happy-genes.jsonl"));
    const cycleStore = new CycleStore(join(fixture.root, "e2e-happy-cycles.jsonl"));
    const minted = mintGene(gene());
    await geneStore.appendGene(minted, T0);
    const runtime = new AgentRuntime(options("cycle-happy", geneStore, cycleStore));
    const result = await runtime.send("用 snippet 方式改一处");

    assert.equal(result.evaluation.status, "success");
    assert.equal(result.evaluation.reviewer, "mechanical");
    assert.equal(result.cycleId.length > 0, true);
    const state = (await cycleStore.states()).get(result.cycleId);
    assert.equal(state?.phase, "completed");
    const kinds = (await readFile(join(fixture.root, "e2e-happy-cycles.jsonl"), "utf8"))
      .trim().split("\n").map((line) => JSON.parse(line).event.type);
    assert.deepEqual(kinds, ["execute-start", "review-ready", "integrate-ready", "complete"]);
    const outcome = JSON.parse((await readFile(join(fixture.root, "e2e-happy-genes.jsonl"), "utf8")).trim().split("\n")[1]!);
    assert.equal(outcome.status, "success");
    assert.equal(outcome.succeeded, true);
    assert.equal(outcome.address, minted.address);
  });

  it("calls a round with a failed tool partial, not a success", async () => {
    const geneStore = new GeneStore(join(fixture.root, "e2e-partial-genes.jsonl"));
    const cycleStore = new CycleStore(join(fixture.root, "e2e-partial-cycles.jsonl"));
    const adapter = createScriptedAdapter({
      steps: [
        { content: "", toolCalls: [call("read_file", { path: join(fixture.root, "does-not-exist.txt") })] },
        { content: "done" },
      ],
    });
    const runtime = new AgentRuntime({
      ...options("cycle-partial", geneStore, cycleStore, adapter),
      tools: new ToolRegistry([createReadFileTool()]),
    });
    const result = await runtime.send("读一个不存在的文件");

    assert.equal(result.evaluation.status, "partial");
    assert.equal(result.evaluation.evidence.includes("toolErrors=1"), true);
    assert.equal((await cycleStore.states()).get(result.cycleId)?.phase, "completed");
    const rows = (await readFile(join(fixture.root, "e2e-partial-genes.jsonl"), "utf8")).trim().split("\n");
    assert.equal(JSON.parse(rows[0]!).succeeded, false);
    assert.equal(JSON.parse(rows[0]!).status, "partial");
  });

  it("closes a failed round as failed and still charges the applied gene", async () => {
    const geneStore = new GeneStore(join(fixture.root, "e2e-fail-genes.jsonl"));
    const cycleStore = new CycleStore(join(fixture.root, "e2e-fail-cycles.jsonl"));
    const minted = mintGene(gene());
    await geneStore.appendGene(minted, T0);
    const runtime = new AgentRuntime(options("cycle-fail", geneStore, cycleStore, createScriptedAdapter({ steps: [] })));

    await assert.rejects(() => runtime.send("用 snippet 方式改一处"));
    const states = await cycleStore.states();
    const failed = [...states.values()].at(-1);
    assert.equal(failed?.phase, "failed");
    assert.equal(failed?.evaluation?.status, "failed");
    assert.equal(failed?.evaluation?.failureClass, "unknown");
    const state = await geneStore.state();
    assert.equal(state.genes.get(minted.address)?.expression.attempts, 1);
    assert.equal(state.genes.get(minted.address)?.expression.streak, 1);
  });

  it("leaves no cycle behind when a send never starts", async () => {
    const geneStore = new GeneStore(join(fixture.root, "e2e-refused-genes.jsonl"));
    const cycleStore = new CycleStore(join(fixture.root, "e2e-refused-cycles.jsonl"));
    const runtime = new AgentRuntime(options("cycle-refused", geneStore, cycleStore));
    await assert.rejects(() => runtime.send("   "));
    assert.equal((await cycleStore.states()).size, 0);
  });

  it("feeds one failure back into the next selection", async () => {
    const geneStore = new GeneStore(join(fixture.root, "e2e-feedback-genes.jsonl"));
    const cycleStore = new CycleStore(join(fixture.root, "e2e-feedback-cycles.jsonl"));
    const first = mintGene(gene({ name: "first", signalsMatch: ["snippet"] }));
    const second = mintGene(gene({ name: "second", signalsMatch: ["snippet"] }));
    await geneStore.appendGene(first, T0);
    await geneStore.appendGene(second, T0);

    // Round one: both genes are equally fresh, so the library breaks the tie
    // deterministically. That round fails, and the failure has to change what
    // the next round picks — that is the whole point of journaling outcomes.
    const runtime = new AgentRuntime(options("feedback-1", geneStore, cycleStore, createScriptedAdapter({ steps: [] })));
    await assert.rejects(() => runtime.send("用 snippet 方式改一处"));
    const state = await geneStore.state();
    const charged = [...state.genes.values()].filter((entry) => entry.expression.attempts === 1);
    assert.equal(charged.length, 1);
    assert.equal(charged[0]?.expression.successes, 0);
    assert.equal(charged[0]?.expression.streak, 1);
    const failedAddress = [...state.genes.entries()].find(([, entry]) => entry.expression.attempts === 1)?.[0];
    assert.ok(failedAddress);

    // The next round must not pick the gene that just failed.
    const next = new AgentRuntime(options("feedback-2", geneStore, cycleStore));
    const result = await next.send("用 snippet 方式改一处");
    assert.notEqual(result.appliedGene?.address, failedAddress);
    assert.equal(result.evaluation.status, "success");
    assert.equal((await geneStore.state()).genes.get(result.appliedGene!.address)?.expression.successes, 1);
  });
});
