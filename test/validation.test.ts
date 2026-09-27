import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { checkClaim, checkValidation, claimsOf, readClaim, validationEvidence } from "../src/validation.ts";
import type { RoundEvidence } from "../src/validation.ts";
import { mintGene } from "../src/gene.ts";
import type { GeneDraft, GeneValidation } from "../src/gene.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { GeneStore } from "../src/gene-store.ts";
import { CycleStore } from "../src/cycle-store.ts";
import { SessionStore } from "../src/session-store.ts";
import { ToolRegistry, createEditFileTool } from "../src/tools.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { createTestFixture } from "./fixtures.ts";
import type { ToolCall } from "../src/types.ts";

let fixture: Awaited<ReturnType<typeof createTestFixture>>;

before(async () => {
  fixture = await createTestFixture("validation");
});

const NOTHING: RoundEvidence = { filesWritten: [], tools: [] };

function evidence(overrides: Partial<RoundEvidence> = {}): RoundEvidence {
  return { ...NOTHING, ...overrides };
}

function draft(validation: readonly (GeneValidation | string)[], overrides: Partial<GeneDraft> = {}): GeneDraft {
  return {
    name: "checked", intent: "build", signalsMatch: ["改文件"], preconditions: [],
    strategy: [{ kind: "act", text: "改" }, { kind: "verify", text: "查" }],
    constraints: { maxFiles: 2, maxLines: 50, forbiddenPaths: [] },
    validation, avoid: [],
    ...overrides,
  };
}

describe("claim kinds", () => {
  it("checks files-written as set equality, so understating a claim also fails", () => {
    const claim: GeneValidation = { kind: "files-written", paths: ["a.ts"] };
    assert.equal(checkClaim(claim, evidence({ filesWritten: ["a.ts"] })).outcome, "met");
    assert.equal(checkClaim(claim, evidence({ filesWritten: [] })).outcome, "unmet");
    assert.equal(checkClaim(claim, evidence({ filesWritten: ["a.ts", "b.ts"] })).outcome, "unmet");
    assert.match(checkClaim(claim, evidence({ filesWritten: ["a.ts", "b.ts"] })).detail, /also wrote b\.ts/);
    assert.match(checkClaim(claim, evidence({ filesWritten: [] })).detail, /never wrote a\.ts/);
  });

  it("does not care how many times the same file was written", () => {
    const claim: GeneValidation = { kind: "files-written", paths: ["a.ts"] };
    assert.equal(checkClaim(claim, evidence({ filesWritten: ["a.ts", "a.ts"] })).outcome, "met");
  });

  it("checks no-write against the ledger", () => {
    const claim: GeneValidation = { kind: "no-write" };
    assert.equal(checkClaim(claim, NOTHING).outcome, "met");
    const result = checkClaim(claim, evidence({ filesWritten: ["a.ts"] }));
    assert.equal(result.outcome, "unmet");
    assert.match(result.detail, /wrote a\.ts/);
  });

  it("checks tool-used, and honours a claimed minimum count", () => {
    assert.equal(checkClaim({ kind: "tool-used", tool: "read_file" }, evidence({ tools: ["read_file"] })).outcome, "met");
    assert.equal(checkClaim({ kind: "tool-used", tool: "read_file" }, NOTHING).outcome, "unmet");
    assert.equal(
      checkClaim({ kind: "tool-used", tool: "read_file", times: 2 }, evidence({ tools: ["read_file"] })).outcome,
      "unmet",
    );
    assert.equal(
      checkClaim({ kind: "tool-used", tool: "read_file", times: 2 }, evidence({ tools: ["read_file", "read_file"] })).outcome,
      "met",
    );
  });

  it("reports a command as unverifiable rather than pretending either way", () => {
    const result = checkClaim({ kind: "command", command: "npm.cmd test" }, NOTHING);
    assert.equal(result.outcome, "unverifiable");
    assert.match(result.detail, /no command runner/);
  });
});

describe("the report", () => {
  it("is satisfied only when every claim is met", () => {
    const report = checkValidation([
      { kind: "no-write" },
      { kind: "tool-used", tool: "read_file" },
    ], evidence({ tools: ["read_file"] }));
    assert.equal(report.satisfied, true);
    assert.deepEqual(report.failed, []);
  });

  it("never counts an unverifiable claim as satisfied", () => {
    const report = checkValidation([{ kind: "command", command: "npm.cmd test" }], NOTHING);
    assert.equal(report.satisfied, false);
    assert.equal(report.claims[0]?.outcome, "unverifiable");
    // Not met, but also not a failure: nothing was contradicted.
    assert.deepEqual(report.failed, []);
  });

  it("separates contradicted claims from undecidable ones", () => {
    const report = checkValidation([
      { kind: "no-write" },
      { kind: "command", command: "npm.cmd test" },
    ], evidence({ filesWritten: ["a.ts"] }));
    assert.equal(report.satisfied, false);
    assert.equal(report.failed.length, 1);
    assert.equal(report.failed[0]?.claim.kind, "no-write");
  });

  it("renders one evidence line per claim", () => {
    const lines = validationEvidence(checkValidation([{ kind: "no-write" }], NOTHING));
    assert.deepEqual(lines, ["validation:met=no-write (no file was written)"]);
  });
});

describe("reading claims", () => {
  it("keeps a bare string as a command claim rather than reinterpreting it", () => {
    assert.deepEqual(readClaim("npm.cmd test"), { kind: "command", command: "npm.cmd test" });
    assert.deepEqual(readClaim({ kind: "no-write" }), { kind: "no-write" });
  });

  it("normalises a draft's strings at mint", () => {
    const { gene } = mintGene(draft(["npm.cmd test"]));
    assert.deepEqual(gene.validation, [{ kind: "command", command: "npm.cmd test" }]);
    assert.deepEqual(claimsOf(gene), gene.validation);
  });

  it("refuses a malformed claim at mint instead of comparing it as met later", () => {
    assert.throws(() => mintGene(draft([{ kind: "files-written", paths: [] } as never])), /paths must be a non-empty array/);
    assert.throws(() => mintGene(draft([{ kind: "tool-used", tool: "" } as never])), /must be a non-empty array|non-empty strings/);
    assert.throws(() => mintGene(draft([{ kind: "tool-used", tool: "read_file", times: 0 } as never])), /times must be a positive integer/);
    assert.throws(() => mintGene(draft([{ kind: "wat" } as never])), /kind must be one of/);
    assert.throws(() => mintGene(draft([])), /validation must be a non-empty array/);
  });
});

describe("validation in the cycle", () => {
  async function run(steps: ReadonlyArray<{ content: string; toolCalls?: ToolCall[] }>, geneDraft: GeneDraft, sessionId: string) {
    const geneStore = new GeneStore(join(fixture.root, `v-genes-${sessionId}.jsonl`));
    const minted = mintGene(geneDraft);
    await geneStore.appendGene(minted);
    const store = new SessionStore({ root: fixture.storeRoot });
    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({ steps: [...steps] }),
      store, sessionId, home: fixture.home, workspaceRoot: fixture.workspaceRoot,
      geneStore, cycleStore: new CycleStore(join(fixture.root, `v-cycles-${sessionId}.jsonl`)),
      tools: new ToolRegistry([createEditFileTool()]),
      approve: async () => true,
    });
    return { result: await runtime.send("改文件"), store, minted };
  }

  it("records a met claim and keeps the round a success", async () => {
    const target = join(fixture.workspaceRoot, "claim-ok.txt");
    await writeFile(target, "old\n", "utf8");
    const { result } = await run(
      [
        { content: "", toolCalls: [{ id: "c1", name: "edit_file", arguments: JSON.stringify({ path: "claim-ok.txt", content: "new\n" }) }] },
        { content: "done" },
      ],
      draft([{ kind: "files-written", paths: ["claim-ok.txt"] }]),
      "claim-ok",
    );
    assert.equal(result.evaluation.status, "success");
    assert.equal(result.validation?.claims[0]?.outcome, "met");
    assert.equal(result.validation?.satisfied, true);
  });

  it("downgrades the round when the gene's own claim is contradicted", async () => {
    const target = join(fixture.workspaceRoot, "claim-bad.txt");
    await writeFile(target, "old\n", "utf8");
    // The gene claims it writes nothing, but the round edits a file.
    const { result } = await run(
      [
        { content: "", toolCalls: [{ id: "c1", name: "edit_file", arguments: JSON.stringify({ path: "claim-bad.txt", content: "new\n" }) }] },
        { content: "done" },
      ],
      draft([{ kind: "no-write" }]),
      "claim-bad",
    );
    assert.equal(result.evaluation.status, "partial");
    assert.equal(result.validation?.failed.length, 1);
    assert.equal(result.evaluation.evidence.some((line) => line.startsWith("validation:unmet")), true);
  });

  it("records an unverifiable command claim without failing the round", async () => {
    const target = join(fixture.workspaceRoot, "claim-cmd.txt");
    await writeFile(target, "old\n", "utf8");
    const { result } = await run(
      [
        { content: "", toolCalls: [{ id: "c1", name: "edit_file", arguments: JSON.stringify({ path: "claim-cmd.txt", content: "new\n" }) }] },
        { content: "done" },
      ],
      draft(["npm.cmd test"]),
      "claim-cmd",
    );
    assert.equal(result.evaluation.status, "success");
    assert.equal(result.validation?.claims[0]?.outcome, "unverifiable");
    assert.equal(result.validation?.satisfied, false);
    assert.equal(result.evaluation.evidence.some((line) => line.startsWith("validation:unverifiable")), true);
  });

  it("writes the claim results into the cycle journal", async () => {
    const target = join(fixture.workspaceRoot, "claim-journal.txt");
    await writeFile(target, "old\n", "utf8");
    const { result } = await run(
      [
        { content: "", toolCalls: [{ id: "c1", name: "edit_file", arguments: JSON.stringify({ path: "claim-journal.txt", content: "new\n" }) }] },
        { content: "done" },
      ],
      draft([{ kind: "files-written", paths: ["claim-journal.txt"] }]),
      "claim-journal",
    );
    const cycleStore = new CycleStore(join(fixture.root, "v-cycles-claim-journal.jsonl"));
    const states = await cycleStore.states();
    const state = states.get(result.cycleId);
    assert.ok(state, "expected the cycle in the journal");
    assert.equal(state!.evaluation?.evidence.some((line) => line.includes("validation:met")), true);
  });

  it("reports no validation at all when no gene applied", async () => {
    const store = new SessionStore({ root: fixture.storeRoot });
    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({ steps: [{ content: "done" }] }),
      store, sessionId: "claim-none", home: fixture.home, workspaceRoot: fixture.workspaceRoot,
      geneStore: new GeneStore(join(fixture.root, "v-genes-none.jsonl")),
      cycleStore: new CycleStore(join(fixture.root, "v-cycles-none.jsonl")),
    });
    const result = await runtime.send("随便问一句");
    assert.equal(result.appliedGene, undefined);
    assert.equal(result.validation, undefined);
  });
});
