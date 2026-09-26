import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";

import { DEFAULT_DISTILL_THRESHOLD, distillGuards, draftAddress, unmintedDrafts } from "../src/distill.ts";
import type { FailureFact } from "../src/distill.ts";
import { GeneStore } from "../src/gene-store.ts";
import { mintGene } from "../src/gene.ts";
import { SessionStore } from "../src/session-store.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { CycleStore } from "../src/cycle-store.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { createTestFixture } from "./fixtures.ts";

let fixture: Awaited<ReturnType<typeof createTestFixture>>;

before(async () => {
  fixture = await createTestFixture("distill");
});

const T0 = 1_700_000_000_000;

function fact(overrides: Partial<FailureFact> = {}): FailureFact {
  return {
    at: T0,
    intent: "build",
    signals: ["包工头", "代码"],
    failureClass: "budget",
    evidence: ["steps=10"],
    address: null,
    ...overrides,
  };
}

describe("distillation threshold", () => {
  it("proposes nothing until the same kind of request fails enough times", () => {
    assert.equal(distillGuards([fact(), fact()]).length, 0);
    const drafts = distillGuards([fact(), fact(), fact()]);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]?.rounds, 3);
    assert.equal(drafts[0]?.gene.intent, "build");
    assert.deepEqual(drafts[0]?.signals, ["代码", "包工头"]);
  });

  it("keeps only the vocabulary that actually recurs", () => {
    const drafts = distillGuards([
      fact({ signals: ["包工头", "代码", "一次性的"] }),
      fact({ signals: ["包工头", "代码"] }),
      fact({ signals: ["包工头", "代码"] }),
    ]);
    assert.deepEqual(drafts[0]?.signals, ["代码", "包工头"]);
  });

  it("proposes nothing when no signal recurs — an unselectable guard is noise", () => {
    assert.equal(distillGuards([
      fact({ signals: ["甲"] }), fact({ signals: ["乙"] }), fact({ signals: ["丙"] }),
    ]).length, 0);
  });

  it("never merges different intents or different failure classes", () => {
    // Three build/budget rounds plus a fix round and two other classes: only the
    // group that reached the threshold may produce a draft.
    const drafts = distillGuards([
      fact({ intent: "build" }), fact({ intent: "build" }), fact({ intent: "build" }),
      fact({ intent: "fix" }), fact({ intent: "fix" }), fact({ intent: "fix" }),
      fact({ intent: "build", failureClass: "unknown" }),
      fact({ intent: "build", failureClass: "model" }),
    ]);
    assert.equal(drafts.length, 2);
    assert.deepEqual(drafts.map((draft) => `${draft.gene.intent}/${draft.failureClass}`), ["build/budget", "fix/budget"]);
  });

  it("counts gene-less failures too — nothing fitting is itself the gap", () => {
    const drafts = distillGuards([fact({ address: null }), fact({ address: null }), fact({ address: null })]);
    assert.equal(drafts.length, 1);
    assert.equal(DEFAULT_DISTILL_THRESHOLD, 3);
  });

  it("is deterministic: the same archive distills to the same draft", () => {
    const archive = [fact(), fact({ at: T0 + 1 }), fact({ at: T0 + 2 })];
    assert.equal(draftAddress(distillGuards(archive)[0]!), draftAddress(distillGuards(archive)[0]!));
    assert.deepEqual(distillGuards(archive), distillGuards([...archive]));
  });
});

describe("admission gate still holds the draft", () => {
  it("emits a guard-only gene that mintGene refuses until validation is real", () => {
    const draft = distillGuards([fact(), fact(), fact()])[0]!;
    assert.deepEqual(draft.gene.strategy.map((step) => step.kind), ["guard"]);
    assert.throws(() => mintGene(draft.gene), /validation/);
    const minted = mintGene({ ...draft.gene, validation: ["npm.cmd test"] });
    assert.match(minted.address, /^sha256:/);
  });

  it("does not propose a pattern the library already covers", () => {
    const draft = distillGuards([fact(), fact(), fact()])[0]!;
    const existing = mintGene({ ...draft.gene, validation: ["npm.cmd test"] });
    assert.equal(unmintedDrafts([draft], [{ gene: existing.gene }]).length, 0);
    assert.equal(unmintedDrafts([draft], []).length, 1);
  });
});

describe("failure archive", () => {
  it("returns only failures that name the request kind", async () => {
    const store = new GeneStore(join(fixture.root, "archive.jsonl"));
    await store.appendOutcome({ address: null, succeeded: true, status: "success" }, T0);
    await store.appendOutcome({ address: null, succeeded: false, status: "failed", failureClass: "budget", intent: "build", signals: ["甲"], evidence: ["steps=10"] }, T0 + 1);
    // A row from before the archive existed: folded, but it cannot join a pattern.
    await store.appendOutcome({ address: null, succeeded: false, status: "failed", failureClass: "unknown" }, T0 + 2);
    const facts = await store.failures();
    assert.equal(facts.length, 1);
    assert.deepEqual(facts[0]?.signals, ["甲"]);
    assert.equal(facts[0]?.failureClass, "budget");
  });
});

describe("failures survive to distillation end to end", () => {
  it("turns three failing rounds into a guard draft on the real journal", async () => {
    const geneStore = new GeneStore(join(fixture.root, "e2e-distill-genes.jsonl"));
    const cycleStore = new CycleStore(join(fixture.root, "e2e-distill-cycles.jsonl"));
    for (let round = 0; round < 3; round++) {
      const runtime = new AgentRuntime({
        adapter: createScriptedAdapter({ steps: [] }),
        store: new SessionStore({ root: fixture.storeRoot }),
        sessionId: `distill-${round}`,
        home: fixture.home, workspaceRoot: fixture.workspaceRoot, geneStore, cycleStore,
      });
      await assert.rejects(() => runtime.send("用包工头的方式改一处代码"));
    }

    const facts = await geneStore.failures();
    assert.equal(facts.length, 3);
    assert.equal(facts.every((fact) => fact.intent === "build"), true);
    assert.equal(facts.every((fact) => fact.signals.length > 0), true);

    const drafts = distillGuards(facts);
    assert.equal(drafts.length, 1);
    assert.equal(drafts[0]?.rounds, 3);
    // CJK carries no word boundaries, so the recurring vocabulary shows up as
    // the phrase's bigrams rather than one whole-sentence token.
    assert.equal(drafts[0]?.signals.includes("工头"), true);
    // The journal carries mechanical evidence, never the raw error text.
    assert.equal(facts.some((fact) => fact.evidence.some((item) => item.includes("scripted adapter"))), false);
  });
});
