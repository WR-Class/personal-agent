import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { DEFAULT_CAVEAT, DEFAULT_INDUCT_THRESHOLD, inductGenes, uncoveredCandidates } from "../src/induct.ts";
import type { SuccessFact } from "../src/induct.ts";
import { GeneStore } from "../src/gene-store.ts";
import { mintGene } from "../src/gene.ts";
import { SessionStore } from "../src/session-store.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { CycleStore } from "../src/cycle-store.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { createTestFixture } from "./fixtures.ts";
import type { ToolCall } from "../src/types.ts";

let fixture: Awaited<ReturnType<typeof createTestFixture>>;

before(async () => {
  fixture = await createTestFixture("induct");
});

const T0 = 1_700_000_000_000;

function fact(overrides: Partial<SuccessFact> = {}): SuccessFact {
  return {
    at: T0,
    intent: "research",
    signals: ["研究", "文档"],
    tools: ["read_file"],
    evidence: ["steps=2"],
    ...overrides,
  };
}

function call(name: string, args: Record<string, unknown>, id = "call_1"): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

describe("induction threshold and grouping", () => {
  it("proposes nothing from a single success", () => {
    assert.equal(inductGenes([fact()]).length, 0);
    assert.equal(DEFAULT_INDUCT_THRESHOLD, 2);
  });

  it("turns repeated gene-less successes into a candidate for that request kind", () => {
    const drafts = inductGenes([fact(), fact()]);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]?.gene.intent, "research");
    assert.equal(drafts[0]?.rounds, 2);
    assert.deepEqual(drafts[0]?.signals, ["文档", "研究"]);
  });

  it("keeps only the vocabulary that recurs", () => {
    const drafts = inductGenes([
      fact({ signals: ["研究", "文档", "一次性的"] }),
      fact({ signals: ["研究", "文档"] }),
    ]);
    assert.deepEqual(drafts[0]?.signals, ["文档", "研究"]);
  });

  it("proposes nothing when no signal recurs", () => {
    assert.equal(inductGenes([fact({ signals: ["甲"] }), fact({ signals: ["乙"] })]).length, 0);
  });

  it("never merges different intents", () => {
    const drafts = inductGenes([
      fact({ intent: "research" }), fact({ intent: "research" }),
      fact({ intent: "operate" }), fact({ intent: "operate" }),
    ]);
    assert.deepEqual(drafts.map((draft) => draft.gene.intent), ["operate", "research"]);
  });

  it("is deterministic, and prefers the most complete proven tool order", () => {
    const archive = [
      fact({ at: T0 + 1, tools: ["read_file"] }),
      fact({ at: T0 + 2, tools: ["read_file", "edit_file"] }),
    ];
    assert.deepEqual(inductGenes(archive), inductGenes([...archive]));
    assert.deepEqual(inductGenes(archive)[0]?.tools, ["read_file", "edit_file"]);
  });
});

describe("what the candidate does and does not claim", () => {
  it("records only the tool order the transcript proved", () => {
    const draft = inductGenes([fact({ tools: ["read_file", "edit_file"] }), fact({ tools: ["read_file", "edit_file"] })])[0]!;
    assert.deepEqual(draft.gene.strategy, [
      { kind: "act", text: "调用 read_file" },
      { kind: "act", text: "调用 edit_file" },
    ]);
    // No guard/verify was inferred: that would be reading intent into a transcript.
    assert.equal(draft.gene.strategy.some((step) => step.kind === "guard" || step.kind === "verify"), false);
    assert.equal(draft.caveat, DEFAULT_CAVEAT);
  });

  it("admits a round that needed no tools, without pretending it learned one", () => {
    const draft = inductGenes([fact({ tools: [] }), fact({ tools: [] })])[0]!;
    assert.deepEqual(draft.tools, []);
    assert.match(draft.gene.strategy[0]!.text, /没有工具调用/);
  });

  it("is refused by mintGene until the operator supplies validation", () => {
    const draft = inductGenes([fact(), fact()])[0]!;
    // Two independent refusals: no validation, and an acting strategy with no
    // verify step. Both are the gate, not an oversight.
    assert.throws(() => mintGene(draft.gene), /validation|must also verify/);
    assert.throws(() => mintGene({ ...draft.gene, validation: ["npm.cmd test"] }), /must also verify/);
    const completed = mintGene({
      ...draft.gene,
      strategy: [...draft.gene.strategy, { kind: "verify", text: "重读确认" }],
      validation: ["npm.cmd test"],
    });
    assert.match(completed.address, /^sha256:/);
  });

  it("does not propose a request kind the library already covers", () => {
    const draft = inductGenes([fact(), fact()])[0]!;
    const existing = mintGene({
      ...draft.gene,
      strategy: [...draft.gene.strategy, { kind: "verify", text: "重读确认" }],
      validation: ["npm.cmd test"],
    });
    assert.equal(uncoveredCandidates([draft], [{ gene: existing.gene }]).length, 0);
    assert.equal(uncoveredCandidates([draft], []).length, 1);
  });
});

describe("gene-less success archive", () => {
  it("returns only successful rounds that applied no gene", async () => {
    const store = new GeneStore(join(fixture.root, "induct-archive.jsonl"));
    const minted = mintGene({
      name: "applied", intent: "build", signalsMatch: ["甲"], preconditions: [],
      strategy: [{ kind: "act", text: "做" }, { kind: "verify", text: "查" }],
      constraints: { maxFiles: 1, maxLines: 5, forbiddenPaths: [] }, validation: ["npm.cmd test"], avoid: [],
    });
    await store.appendGene(minted, T0);
    // A gap: succeeded with no gene to use.
    await store.appendOutcome({ address: null, succeeded: true, status: "success", intent: "research", signals: ["文档"], tools: ["read_file"] }, T0 + 1);
    // Not a gap: a gene was applied.
    await store.appendOutcome({ address: minted.address, succeeded: true, status: "success", intent: "build", signals: ["甲"], tools: [] }, T0 + 2);
    // Not a success at all.
    await store.appendOutcome({ address: null, succeeded: false, status: "failed", failureClass: "unknown", intent: "fix", signals: ["乙"] }, T0 + 3);

    const facts = await store.geneLessSuccesses();
    assert.equal(facts.length, 1);
    assert.equal(facts[0]?.intent, "research");
    assert.deepEqual(facts[0]?.tools, ["read_file"]);
  });
});

describe("induction on the real journal", () => {
  it("captures a gene-less success with the tools it actually used", async () => {
    const geneStore = new GeneStore(join(fixture.root, "e2e-induct-genes.jsonl"));
    const cycleStore = new CycleStore(join(fixture.root, "e2e-induct-cycles.jsonl"));
    // A file the runtime is actually allowed to read: inside its workspace.
    const target = join(fixture.workspaceRoot, "present.txt");
    await (await import("node:fs/promises")).writeFile(target, "hello", "utf8");
    const steps = () => createScriptedAdapter({
      steps: [
        { content: "", toolCalls: [call("read_file", { path: "present.txt" })] },
        { content: "done" },
      ],
    });
    const { ToolRegistry, createReadFileTool } = await import("../src/tools.ts");

    for (let round = 0; round < 2; round++) {
      const runtime = new AgentRuntime({
        adapter: steps(), store: new SessionStore({ root: fixture.storeRoot }), sessionId: `induct-${round}`,
        home: fixture.home, workspaceRoot: fixture.workspaceRoot, geneStore, cycleStore,
        tools: new ToolRegistry([createReadFileTool()]),
      });
      const result = await runtime.send("研究一下 present.txt 的内容");
      assert.equal(result.evaluation.status, "success");
      assert.equal(result.appliedGene, undefined);
    }

    const facts = await geneStore.geneLessSuccesses();
    assert.equal(facts.length, 2);
    assert.equal(facts.every((entry) => entry.tools.includes("read_file")), true);

    const drafts = inductGenes(facts);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]?.gene.intent, "research");
    assert.equal(drafts[0]?.tools.includes("read_file"), true);
    // The candidate is a proposal, never a capability: the gate refuses it both
    // for the missing validation and for acting without a verify step.
    assert.throws(() => mintGene(drafts[0]!.gene), /must also verify/);
  });
});
