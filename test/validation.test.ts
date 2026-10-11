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
import { ToolRegistry, createEditFileTool, createRunCommandTool, type Tool } from "../src/tools.ts";
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
    constraints: { maxFiles: 2, forbiddenPaths: [] },
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

  it("decides a command the round ran, instead of reporting it as undecidable", () => {
    const ran = evidence({ commands: [{ command: "npm.cmd test", exitCode: 0 }] });
    const result = checkClaim({ kind: "command", command: "npm.cmd test" }, ran);
    assert.equal(result.outcome, "met");
    assert.match(result.detail, /exit code 0/);
  });

  it("⚠️ contradicts the claim when the command it names ran and failed", () => {
    // The case this round exists for. Before it, every command claim was
    // unverifiable, so a round could declare "prove it with npm test", fail it,
    // and still be recorded as a clean success — the strongest claim a gene can
    // make was the one claim nothing checked.
    const failed = evidence({ commands: [{ command: "npm.cmd test", exitCode: 1 }] });
    const result = checkClaim({ kind: "command", command: "npm.cmd test" }, failed);
    assert.equal(result.outcome, "unmet");
    assert.match(result.detail, /exited 1/);
  });

  it("matches a claim that is a fragment of the command that actually ran", () => {
    const ran = evidence({ commands: [{ command: "cd personal-agent && npm.cmd   test", exitCode: 0 }] });
    assert.equal(checkClaim({ kind: "command", command: "npm.cmd test" }, ran).outcome, "met");
  });

  it("takes the last run, so a later failure is not hidden by an earlier pass", () => {
    const passedThenFailed = evidence({
      commands: [
        { command: "npm.cmd test", exitCode: 0 },
        { command: "npm.cmd test", exitCode: 1 },
      ],
    });
    assert.equal(checkClaim({ kind: "command", command: "npm.cmd test" }, passedThenFailed).outcome, "unmet");
    const failedThenPassed = evidence({
      commands: [
        { command: "npm.cmd test", exitCode: 1 },
        { command: "npm.cmd test", exitCode: 0 },
      ],
    });
    assert.equal(checkClaim({ kind: "command", command: "npm.cmd test" }, failedThenPassed).outcome, "met");
  });

  it("never reads a missing exit code as success", () => {
    const background = evidence({ commands: [{ command: "npm.cmd test", exitCode: null }] });
    const result = checkClaim({ kind: "command", command: "npm.cmd test" }, background);
    assert.equal(result.outcome, "unverifiable");
    assert.match(result.detail, /no exit code was recorded/);
  });

  it("stays undecidable when the round ran other commands, and does not call the claim unmet", () => {
    // A round is not the whole task: the proof may have been shown earlier, so
    // "not seen here" must never be recorded as "not done".
    const other = evidence({ commands: [{ command: "git status", exitCode: 0 }] });
    const result = checkClaim({ kind: "command", command: "npm.cmd test" }, other);
    assert.equal(result.outcome, "unverifiable");
    assert.match(result.detail, /none containing/);
  });

  it("refuses a claim that names no command, rather than matching every command", () => {
    const ran = evidence({ commands: [{ command: "git status", exitCode: 0 }] });
    assert.equal(checkClaim({ kind: "command", command: "   " }, ran).outcome, "unverifiable");
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
  async function run(
    steps: ReadonlyArray<{ content: string; toolCalls?: ToolCall[] }>,
    geneDraft: GeneDraft,
    sessionId: string,
    tools: readonly Tool[] = [createEditFileTool()],
  ) {
    const geneStore = new GeneStore(join(fixture.root, `v-genes-${sessionId}.jsonl`));
    const minted = mintGene(geneDraft);
    await geneStore.appendGene(minted);
    const store = new SessionStore({ root: fixture.storeRoot });
    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({ steps: [...steps] }),
      store, sessionId, home: fixture.home, workspaceRoot: fixture.workspaceRoot,
      geneStore, cycleStore: new CycleStore(join(fixture.root, `v-cycles-${sessionId}.jsonl`)),
      tools: new ToolRegistry([...tools]),
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

  it("⚠️ decides a command claim from the round's real execution record", async () => {
    // The wiring this test exists for. The checker could always compare a command
    // claim; nothing ever handed it the command or its exit code, so every such
    // claim was reported undecidable no matter what the round actually did — and
    // a round that failed its own declared proof still ended as a clean success.
    // This is the only test that runs the whole path: tool call, real shell, exit
    // code, evidence, verdict.
    await writeFile(join(fixture.workspaceRoot, "fail.cjs"), "process.exit(5);", "utf8");
    const { result } = await run(
      [
        { content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ command: "node fail.cjs" }) }] },
        { content: "测试通过了" },
      ],
      draft([{ kind: "command", command: "node fail.cjs" }]),
      "claim-cmd",
      [createRunCommandTool()],
    );
    assert.equal(result.validation?.claims[0]?.outcome, "unmet", "a non-zero exit must contradict the claim");
    assert.equal(result.evaluation.status, "partial", "and it must not leave the round a clean success");
    assert.equal(result.evaluation.evidence.some((line) => line.startsWith("validation:unmet=command:")), true);
  });

  it("⚠️ retires a gene whose own declared proof was contradicted twice and never held", async () => {
    // The whole loop rather than the rule alone: a real round, a real shell, a real
    // exit code, a real outcome row, and then the library acting on its own record
    // with nobody deciding. This is the first consumer `retire` has ever had.
    await writeFile(join(fixture.workspaceRoot, "fail2.cjs"), "process.exit(5);", "utf8");
    const steps = [
      { content: "", toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ command: "node fail2.cjs" }) }] },
      { content: "测试通过了" },
    ];
    const geneDraft = draft([{ kind: "command", command: "node fail2.cjs" }]);
    const genePath = join(fixture.root, "v-genes-claim-retire.jsonl");
    const first = await run(steps, geneDraft, "claim-retire", [createRunCommandTool()]);
    assert.equal(first.result.appliedGene?.address, first.minted.address, "第一轮确实应用了这条基因");
    assert.equal((await new GeneStore(genePath).state()).retired.size, 0, "一轮不足以退休一条能力");

    await run(steps, geneDraft, "claim-retire", [createRunCommandTool()]);
    // ⚠️ A fresh instance per read, on purpose: a `GeneStore` caches the log it
    // loaded, so reusing one object would answer with the snapshot from the first
    // read and a retirement written in between would be invisible. `append` updates
    // that cache (`this.records?.push`), which is why the runtime — which writes
    // through the same instance it reads — does not need this care.
    const after = await new GeneStore(genePath).state();
    const reason = after.retired.get(first.minted.address) ?? "";
    assert.match(reason, /自动退休/, "理由必须说明这是被规则退休的，而不是被谁拍板的");
    assert.match(reason, /被反驳 2 轮/, "理由必须带上那个数，否则它只是一句评语");

    // And the retirement is load-bearing rather than decorative: the next matching
    // round must no longer run a gene the library has just taken out.
    const third = await run([{ content: "好" }], geneDraft, "claim-retire", [createRunCommandTool()]);
    assert.equal(third.result.appliedGene, undefined, "被退休的基因不该再被应用");
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
