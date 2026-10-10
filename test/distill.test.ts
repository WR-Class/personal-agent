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
    // Required rather than optional (D127): a fact without a measured footprint
    // would silently size the distilled budget from a default. Producers must
    // say "this round wrote nothing" on purpose.
    filesWritten: 0,
    linesWritten: 0,
    budgetRefusals: 0,
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
    // "用包工头的方式改一处代码" routes to fix under the Jev classifier; the
    // assertion is whatever the runtime recorded, not a particular label.
    assert.equal(facts.every((fact) => fact.intent === facts[0]?.intent), true);
    assert.ok(facts[0]?.intent !== undefined);
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

// D127: the guard's budget comes from the rounds it was distilled from, not from
// a constant. This is the end-to-end half of `measuredBudget`'s unit tests — it
// proves the measured figure actually reaches the draft, which is the part that
// would silently regress if `distillGuards` stopped threading the facts through.
describe("distilled budget is measured, not guessed", () => {
  it("sizes the guard from the file and line counts the rounds actually reached", () => {
    const drafts = distillGuards([
      fact({ filesWritten: 4, linesWritten: 90 }),
      fact({ filesWritten: 5, linesWritten: 120 }),
      fact({ filesWritten: 3, linesWritten: 70 }),
    ]);
    assert.equal(drafts.length, 1);
    // The middle of 3, 4 and 5 — and the middle of 70, 90 and 120. This assertion
    // used to be 5 and "at least 120", which is what a p95 quantile does: take the
    // top. That let the figure rise with every unusual round and never come back
    // down, so a guard could be widened but never tightened.
    assert.equal(drafts[0]?.gene.constraints.maxFiles, 4);
    assert.equal(drafts[0]?.gene.constraints.maxLines, 90);
  });

  it("keeps the cold-start fallback for a group with no measurements yet", () => {
    // The three facts default to a zero footprint (this file's helper), which is
    // what a group distilled from pre-D127 journal rows looks like. The estimator
    // filters rows that recorded no footprint at all, so this stays a cold start
    // rather than becoming a measurement of zero.
    const drafts = distillGuards([fact(), fact(), fact()]);
    assert.equal(drafts.length, 1);
    assert.deepEqual(
      { maxFiles: drafts[0]?.gene.constraints.maxFiles, maxLines: drafts[0]?.gene.constraints.maxLines },
      { maxFiles: 1, maxLines: 20 },
    );
  });
});
