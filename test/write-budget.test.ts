import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { budgetFor, chargeWrite, checkWrite, measuredBudget, raiseFor, COLD_START_BUDGET, MIN_MEASURED_BUDGET, GLOBAL_LINE_CAP, readWriteAttempt, WriteBudgetError, countsTowardWriteBudget, isJournalPath } from "../src/write-budget.ts";
import type { LedgerState } from "../src/write-budget.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { GeneStore } from "../src/gene-store.ts";
import { CycleStore } from "../src/cycle-store.ts";
import { SessionStore } from "../src/session-store.ts";
import type { AuditEvent } from "../src/session-store.ts";
import { ToolRegistry, createEditFileTool, createCreateFileTool, createDeleteFileTool } from "../src/tools.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { mintGene } from "../src/gene.ts";
import { createTestFixture } from "./fixtures.ts";
import type { ToolCall } from "../src/types.ts";

let fixture: Awaited<ReturnType<typeof createTestFixture>>;

before(async () => {
  fixture = await createTestFixture("write-budget");
});

function call(name: string, args: Record<string, unknown>, id = `call_${name}`): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

const EMPTY: LedgerState = { files: [], lines: 0 };

describe("reading a write attempt out of a tool call", () => {
  it("counts lines where the arguments actually carry content", () => {
    const attempt = readWriteAttempt("edit_file", JSON.stringify({ path: "a.ts", content: "one\ntwo\nthree\n" }));
    assert.deepEqual(attempt, { tool: "edit_file", path: "a.ts", lines: 3 });
  });

  it("does not count a trailing newline as an extra line", () => {
    assert.equal(readWriteAttempt("create_file", JSON.stringify({ path: "a", content: "x" }))?.lines, 1);
    assert.equal(readWriteAttempt("create_file", JSON.stringify({ path: "a", content: "" }))?.lines, 0);
  });

  it("counts a file but no lines where the arguments carry none", () => {
    assert.deepEqual(readWriteAttempt("delete_file", JSON.stringify({ path: "a.ts" })), { tool: "delete_file", path: "a.ts", lines: null });
  });

  it("treats unreadable arguments as a write of unknown extent, not a free pass", () => {
    assert.deepEqual(readWriteAttempt("edit_file", "{not json"), { tool: "edit_file", path: null, lines: null });
    assert.deepEqual(readWriteAttempt("edit_file", JSON.stringify({ content: "x" })), { tool: "edit_file", path: null, lines: null });
  });

  it("is not a write at all for a read", () => {
    assert.equal(readWriteAttempt("read_file", JSON.stringify({ path: "a.ts" })), null);
  });
});

describe("the ledger", () => {
  it("counts a file once however often it is written", () => {
    const first = chargeWrite(EMPTY, { tool: "edit_file", path: "a.ts", lines: 2 }, 0);
    const second = chargeWrite(first, { tool: "edit_file", path: "a.ts", lines: 3 }, 1);
    assert.deepEqual(second.files, ["a.ts"]);
    assert.equal(second.lines, 5);
  });

  it("refuses the write that would exceed the file budget, and names it", () => {
    const state = chargeWrite(EMPTY, { tool: "edit_file", path: "a.ts", lines: 1 }, 0);
    const decision = checkWrite(state, { tool: "edit_file", path: "b.ts", lines: 1 }, { maxFiles: 1, forbiddenPaths: [] });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason!, /file budget exhausted/);
    assert.match(decision.reason!, /b\.ts/);
  });

  // ⚠️ Inverted from "refuses the write that would exceed the line budget". There
  // is no per-round line budget any more: it governed "write one big document",
  // which is ordinary work, and it refused a 400-line single file that the file
  // counter would have allowed. The reference implementation has no such limit.
  it("no longer refuses a write for its line count, however many lines it carries", () => {
    const state = chargeWrite(EMPTY, { tool: "edit_file", path: "a.ts", lines: 8 }, 0);
    const decision = checkWrite(state, { tool: "edit_file", path: "a.ts", lines: 4_000 }, { maxFiles: 5, forbiddenPaths: [] });
    assert.equal(decision.allowed, true, "4000 lines in one round is a document, not an overrun");
  });

  it("refuses only at the global line ceiling, which is a runaway backstop and not a budget", () => {
    const state = chargeWrite(EMPTY, { tool: "edit_file", path: "a.ts", lines: GLOBAL_LINE_CAP - 1 }, 0);
    const budget = { maxFiles: 5, forbiddenPaths: [] };
    assert.equal(checkWrite(state, { tool: "edit_file", path: "a.ts", lines: 1 }, budget).allowed, true, "exactly the cap is allowed");
    const past = checkWrite(state, { tool: "edit_file", path: "a.ts", lines: 2 }, budget);
    assert.equal(past.allowed, false, "one line past it is not");
    assert.match(past.reason!, /global line ceiling/);
  });

  it("allows exactly the file budget and no more", () => {
    const state = chargeWrite(EMPTY, { tool: "edit_file", path: "a.ts", lines: 10 }, 0);
    assert.equal(checkWrite(state, { tool: "edit_file", path: "a.ts", lines: 0 }, { maxFiles: 1, forbiddenPaths: [] }).allowed, true, "the same file again is not a second file");
    assert.equal(checkWrite(state, { tool: "edit_file", path: "b.ts", lines: 1 }, { maxFiles: 1, forbiddenPaths: [] }).allowed, false);
  });

  it("still charges an anonymous write, so malformed arguments cannot buy budget", () => {
    const state = chargeWrite(EMPTY, { tool: "edit_file", path: null, lines: null }, 0);
    assert.equal(state.files.length, 1);
    const decision = checkWrite(state, { tool: "edit_file", path: null, lines: null }, { maxFiles: 1, forbiddenPaths: [] });
    assert.equal(decision.allowed, false);
    assert.match(decision.reason!, /no readable path/);
  });

  // D103: forbiddenPaths was declared in `types.ts`, parsed in `gene.ts`, and
  // written by both `distill.ts` and `induct.ts`, but `budgetFor`'s parameter type
  // listed fewer members than the interface had, so it never reached an
  // enforcement path. These pin the rule that replaced the record.
  describe("forbidden paths", () => {
    const budgetWith = (forbiddenPaths: readonly string[]) => ({ maxFiles: 9, forbiddenPaths });
    const write = (path: string | null) => ({ tool: "edit_file", path, lines: 1 });

    it("refuses a write under a forbidden directory and names both the path and the entry", () => {
      const decision = checkWrite(EMPTY, write("docs/SAFETY.md"), budgetWith(["docs"]));
      assert.equal(decision.allowed, false);
      assert.match(decision.reason!, /docs\/SAFETY\.md/, "the reason must say what was refused");
      assert.match(decision.reason!, /under docs/, "and which entry refused it, so a gene can be debugged from the audit line alone");
    });

    it("matches by path SEGMENT, not by string prefix", () => {
      // The load-bearing case. A naive `startsWith("docs")` refuses both, and the
      // second is a different directory that merely begins with the same letters.
      // A rule that forbids more than was written down is as wrong as one that
      // forbids less: it makes the gene's declaration mean something else.
      assert.equal(checkWrite(EMPTY, write("docs/a.md"), budgetWith(["docs"])).allowed, false);
      assert.equal(checkWrite(EMPTY, write("docs2/a.md"), budgetWith(["docs"])).allowed, true, "docs2 is not docs");
      assert.equal(checkWrite(EMPTY, write("docs"), budgetWith(["docs"])).allowed, false, "the forbidden path itself, not only what is under it");
    });

    it("refuses regardless of remaining budget, because it is a different kind of limit", () => {
      // A budget says "this much and no more", so running out is an accounting
      // fact. A forbidden path says "not here at all", so a full purse is
      // irrelevant to it. maxFiles 9 is nowhere near spent here.
      const decision = checkWrite(EMPTY, write("secret/x.ts"), budgetWith(["secret"]));
      assert.equal(decision.allowed, false);
      assert.doesNotMatch(decision.reason!, /budget exhausted/, "it must not be reported as a budget, or the operator reads the wrong cause");
    });

    it("refuses a write whose target cannot be read, rather than guessing", () => {
      // Fail closed, on this module's own precedent: unparseable arguments are
      // already charged as a write of unknown extent so malformed arguments cannot
      // buy budget. A target that cannot be read cannot be shown to lie outside the
      // forbidden set, and guessing would make the ban evadable by malforming the
      // call. With no forbidden paths the same write is still allowed, so this
      // costs nothing in the ordinary case.
      assert.equal(checkWrite(EMPTY, write(null), budgetWith(["docs"])).allowed, false);
      assert.equal(checkWrite(EMPTY, write(null), budgetWith([])).allowed, true);
    });

    it("forbids nothing when the list is empty, which is what every gene-less round runs under", () => {
      assert.equal(checkWrite(EMPTY, write("docs/SAFETY.md"), budgetWith([])).allowed, true);
      assert.equal(checkWrite(EMPTY, write("anything/at/all.ts"), budgetWith([])).allowed, true);
    });

    it("compares the way this platform's filesystem does: either separator, either case", () => {
      // The product runs on Windows, where `Docs\A.md` and `docs/a.md` are the same
      // file. A gene that writes one form must not be evaded by the other.
      assert.equal(checkWrite(EMPTY, write("docs\\SAFETY.md"), budgetWith(["docs"])).allowed, false);
      assert.equal(checkWrite(EMPTY, write("Docs/SAFETY.md"), budgetWith(["DOCS"])).allowed, false);
      assert.equal(checkWrite(EMPTY, write("./docs/SAFETY.md"), budgetWith(["docs"])).allowed, false, "a leading ./ is the same path");
      assert.equal(checkWrite(EMPTY, write("docs/SAFETY.md"), budgetWith(["docs/"])).allowed, false, "a trailing separator on the entry is the same root");
    });

    it("carries a gene's forbiddenPaths through budgetFor, and defaults to none when the gene omits them", () => {
      const fromGene = budgetFor({ maxFiles: 1, forbiddenPaths: ["docs", "secrets"] }, { maxFiles: 3, forbiddenPaths: [] });
      assert.deepEqual(fromGene.forbiddenPaths, ["docs", "secrets"]);
      // `distill.ts` and `induct.ts` both mint guard genes with an explicit empty
      // list, but a hand-written gene may omit the key; omission must mean "none",
      // never "inherit the fallback's", or a gene would silently widen its own ban.
      assert.deepEqual(budgetFor({ maxFiles: 1 }, { maxFiles: 3, forbiddenPaths: ["docs"] }).forbiddenPaths, []);
      assert.deepEqual(budgetFor(null, { maxFiles: 3, forbiddenPaths: ["docs"] }).forbiddenPaths, ["docs"], "no gene means the runtime default, which is what the fallback is for");
    });
  });

  it("takes a gene's constraints as declared in both directions, and the default only when no gene applies", () => {
    const fallback = { maxFiles: 3, forbiddenPaths: [] };
    assert.deepEqual(budgetFor({ maxFiles: 9, forbiddenPaths: [] }, fallback), { maxFiles: 9, forbiddenPaths: [] });
    // ⚠️ Inverted from "and the default when they would narrow it" (甲). A default
    // bounds a round that was told *nothing*; a declared constraint is what bounds
    // a round that was told something. A floor underneath it means the declared
    // number can only ever move up — the one-way ratchet 丙 took out of the
    // estimator, left standing at the point of use.
    //
    // COLD_START_BUDGET = {1} is still a guess and still the tightest number in
    // this file. The cure is to **measure** it (`measuredBudget`, and the fold that
    // re-measures genes already in the library), not to hide it under a second
    // number: a guess with a floor under it is a guess nobody ever corrects,
    // because nothing downstream can tell it was wrong.
    assert.deepEqual(budgetFor({ maxFiles: 1, forbiddenPaths: [] }, fallback), { maxFiles: 1, forbiddenPaths: [] });
    // The fallback is what a round with nothing applied gets, and this is the only
    // thing it is for.
    assert.deepEqual(budgetFor(null, fallback), fallback);
  });
});

// (b): the ceiling a round runs under is an estimate. On the road from "no gene"
// to "minted gene" nothing has measured it yet, so its first refusal is evidence
// that the estimate was too low — and the room that was missing is exactly what
// the refused write asked for.
describe("what the budget counts", () => {
  // The journal is written on every round, so charging for it would let a round
  // spend its whole room on its own diary. Test artifacts are the same shape of
  // problem from the other side: the round was told to run the tests, and the
  // runner wrote them — the agent did not choose those files.
  it("does not charge the agent's own journal, or the test artifacts", () => {
    for (const path of [".personal-agent/genes.jsonl", ".personal-agent/sessions/s1.jsonl", ".test-artifacts/run/out.txt"]) {
      assert.equal(countsTowardWriteBudget(path), false, path);
      const after = chargeWrite(EMPTY, { tool: "edit_file", path, lines: 500 }, 0);
      assert.equal(after.files.length, 0, path);
      assert.equal(after.lines, 0, path);
    }
  });

  it("still charges documentation, because a document write is real blast radius", () => {
    for (const path of ["docs/STATUS.md", "README.md", "src/runtime.ts", "test/cycle.test.ts"]) {
      assert.equal(countsTowardWriteBudget(path), true, path);
    }
  });

  it("does not exempt a write whose target could not be read", () => {
    // The same precedent as `checkWrite`'s anonymous slot: a target that cannot
    // be read cannot be shown to be the agent's own diary.
    assert.equal(countsTowardWriteBudget(null), true);
  });

  it("lets an exempt write through a budget that is already full", () => {
    const full = chargeWrite(EMPTY, { tool: "edit_file", path: "a.ts", lines: 0 }, 0);
    const budget = { maxFiles: 1, forbiddenPaths: [] as readonly string[] };
    assert.equal(checkWrite(full, { tool: "edit_file", path: "b.ts", lines: 0 }, budget).allowed, false);
    assert.equal(checkWrite(full, { tool: "edit_file", path: ".personal-agent/genes.jsonl", lines: 0 }, budget).allowed, true);
  });

  it("still refuses an exempt path the cycle forbids", () => {
    // A ban is policy, and an exempt path is still a path this cycle may have
    // forbidden. Exempting the journal from the *count* must not exempt it from
    // the ban, or the restriction would have a hole shaped exactly like the file
    // the agent writes most often.
    const decision = checkWrite(EMPTY, { tool: "edit_file", path: ".personal-agent/genes.jsonl", lines: 1 }, {
      maxFiles: 5, forbiddenPaths: [".personal-agent"],
    });
    assert.equal(decision.allowed, false);
  });

  it("keeps the two lists apart: the journal is narrower than the budget exemption", () => {
    assert.equal(isJournalPath(".personal-agent/x.jsonl"), true);
    // A test artifact is exempt from the count but is not the journal: it is not
    // evidence that the round did work, and it is not evidence that it did not.
    assert.equal(isJournalPath(".test-artifacts/x.txt"), false);
    assert.equal(isJournalPath("docs/STATUS.md"), false);
  });
});

describe("raising an under-sized ceiling", () => {
  const budget = (maxFiles: number, forbiddenPaths: readonly string[] = []) => ({
    maxFiles, forbiddenPaths,
  });
  const write = (path: string | null, lines: number | null = 1) => ({ tool: "edit_file", path, lines });

  it("widens to cover exactly the write that was refused", () => {
    let state = chargeWrite(EMPTY, write("a.ts"), 0);
    state = chargeWrite(state, write("b.ts"), 1);
    const raised = raiseFor(state, write("c.ts", 5), budget(2));
    assert.equal(raised?.maxFiles, 3, "the third file is what was refused, so three is what it takes");
  });

  it("never refuses a rewritten file on the file axis, so there is nothing to raise", () => {
    // ⚠️ Inverted from "charges a rewritten file no extra file slot". That test
    // could only be refused on the line axis, which no longer exists. The ledger's
    // own rule — a file is counted once however often it is written — now has a
    // stronger consequence: writing the same file again cannot exhaust a file
    // budget at all, so `raiseFor` has nothing to correct and must say so rather
    // than inventing room for a write that was never refused.
    const state = chargeWrite(EMPTY, write("a.ts", 8), 0);
    assert.equal(checkWrite(state, write("a.ts", 5), budget(1)).allowed, true, "a.ts is already in the ledger");
    assert.equal(raiseFor(state, write("a.ts", 5), budget(1)), null);
  });

  it("returns null for a policy refusal, because no amount of room lifts a ban", () => {
    assert.equal(raiseFor(EMPTY, write("docs/a.md"), budget(9, ["docs"])), null);
    assert.equal(
      raiseFor(EMPTY, write(null), budget(9, ["docs"])), null,
      "an unreadable target is refused as policy, and raising would spend the round's one raise on a write that stays refused",
    );
  });

  it("returns null when the attempt already fits, so a refusal it cannot explain is never papered over", () => {
    const state = chargeWrite(EMPTY, write("a.ts"), 0);
    assert.equal(raiseFor(state, write("a.ts"), budget(5)), null);
  });
});

describe("enforcement in the runtime", () => {
  async function runWithTools(
    steps: ReadonlyArray<{ content: string; toolCalls?: ToolCall[] }>,
    options: { geneStore?: GeneStore; maxWriteFiles?: number; sessionId: string; signalPrompt?: string },
  ) {
    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({ steps: [...steps] }),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: options.sessionId,
      home: fixture.home,
      workspaceRoot: fixture.workspaceRoot,
      cycleStore: new CycleStore(join(fixture.root, `cycles-${options.sessionId}.jsonl`)),
      ...(options.geneStore ? { geneStore: options.geneStore } : {}),
      ...(options.maxWriteFiles === undefined ? {} : { maxWriteFiles: options.maxWriteFiles }),
      tools: new ToolRegistry([createEditFileTool(), createCreateFileTool(), createDeleteFileTool()]),
      approve: async () => true,
    });
    return runtime.send(options.signalPrompt ?? "改一下文件");
  }

  // (b): the ceiling is a provisional estimate until a gene supplies a number, so
  // its FIRST refusal is read as evidence the estimate was too low and widens it
  // instead of being spent. The second refusal is the wall — and the wall is what
  // the record and the next mint's statistic are for.
  it("raises a provisional file ceiling once, then refuses the write after that", async () => {
    const names = ["one.txt", "two.txt", "three.txt"];
    for (const [index, name] of names.entries()) {
      await writeFile(join(fixture.workspaceRoot, name), `keep${index}\n`, "utf8");
    }

    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({
        steps: [
          {
            content: "",
            toolCalls: names.map((name, index) => call("edit_file", { path: name, content: `w${index}\n` }, `call_${index}`)),
          },
          { content: "done" },
        ],
      }),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: "budget-files", home: fixture.home, workspaceRoot: fixture.workspaceRoot,
      maxWriteFiles: 1,
      tools: new ToolRegistry([createEditFileTool()]),
      approve: async () => true,
    });

    const result = await runtime.send("改三个文件");
    assert.equal(await readFile(join(fixture.workspaceRoot, "one.txt"), "utf8"), "w0\n");
    assert.equal(await readFile(join(fixture.workspaceRoot, "two.txt"), "utf8"), "w1\n", "the first refusal was corrected, not spent");
    assert.equal(await readFile(join(fixture.workspaceRoot, "three.txt"), "utf8"), "keep2\n", "the second refusal is the wall");
    assert.equal(result.budget.filesWritten, 2);
    assert.equal(result.budget.filesWrittenLimit, 2, "the ceiling moved to exactly the write it refused");
    // D127: a budget refusal no longer makes the round `partial`. Nothing broke —
    // the tool never ran — so charging it to the round's success charged the
    // applied gene for a budget that was sized wrong. The pressure is still on
    // the record, as a count that is explicitly not an input to the verdict.
    assert.equal(result.evaluation.status, "success");
    assert.ok(
      result.evaluation.evidence.some((line) => line === "budgetRefusals=1"),
      `expected exactly one standing refusal in evidence, got ${JSON.stringify(result.evaluation.evidence)}`,
    );
  });

  it("journals the ceiling the round ended under, so the estimate can fall later", async () => {
    // The wiring half. `measuredBudget` can only weigh the ceiling against the
    // demand if the round records the ceiling at all — without it the estimator
    // has demands alone, which can rise but has nothing pulling them back down.
    // That is the one-way ratchet, one layer below the one just removed.
    const geneStore = new GeneStore(join(fixture.root, "ceiling-genes.jsonl"));
    for (const name of ["ceil-a.txt", "ceil-b.txt"]) {
      await writeFile(join(fixture.workspaceRoot, name), "keep\n", "utf8");
    }
    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({
        steps: [
          {
            content: "",
            toolCalls: [
              call("edit_file", { path: "ceil-a.txt", content: "a\n" }, "ceil_a"),
              call("edit_file", { path: "ceil-b.txt", content: "b\n" }, "ceil_b"),
            ],
          },
          { content: "done" },
        ],
      }),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: "ceiling-journal", home: fixture.home, workspaceRoot: fixture.workspaceRoot,
      maxWriteFiles: 1, geneStore,
      tools: new ToolRegistry([createEditFileTool()]),
      approve: async () => true,
    });

    const result = await runtime.send("改两个文件");
    assert.equal(result.budget.filesWrittenLimit, 2, "one raise, to exactly the write it refused");

    const facts = await geneStore.geneLessSuccesses();
    const fact = facts.find((entry) => entry.filesWritten === 2);
    assert.ok(fact, `expected this round in the induction archive, got ${JSON.stringify(facts)}`);
    // The *raised* ceiling, not the 1 it started under: the round ended here, and
    // a reader handed the starting number would re-derive the too-small one.
    assert.equal(fact!.ceilingFiles, 2);
  });

  // ⚠️ Deleted: "raises the line ceiling once, and the refusal after that still
  // leaves the file untouched". Its whole subject — a per-round line wall and the
  // single provisional raise that corrected it — no longer exists. A per-round
  // line budget governed "write one big document", which is ordinary work, so the
  // wall is gone rather than moved; `checkWrite`'s unit tests above pin what
  // replaced it (a global runaway backstop that cannot refuse real work).

  it("records both outcomes in the audit log: the raise that allowed a write, and the refusal that stood", async () => {
    for (const name of ["audited-a.txt", "audited-b.txt", "audited-c.txt"]) {
      await writeFile(join(fixture.workspaceRoot, name), "keep\n", "utf8");
    }
    const store = new SessionStore({ root: fixture.storeRoot });
    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({
        steps: [
          {
            content: "",
            toolCalls: [
              call("edit_file", { path: "audited-a.txt", content: "a\n" }, "call_a"),
              call("edit_file", { path: "audited-b.txt", content: "b\n" }, "call_b"),
              call("edit_file", { path: "audited-c.txt", content: "c\n" }, "call_c"),
            ],
          },
          { content: "done" },
        ],
      }),
      store, sessionId: "budget-audit", home: fixture.home, workspaceRoot: fixture.workspaceRoot,
      // One file allowed, three attempted: the second is the raise, the third is
      // the refusal that stands. The same two outcomes the line axis used to
      // produce, now that the file axis is the only one there is.
      maxWriteFiles: 1,
      tools: new ToolRegistry([createEditFileTool()]),
      approve: async () => true,
    });
    await runtime.send("改文件");

    const { events } = await store.inspect("budget-audit");
    const audits = events.filter((event): event is AuditEvent => event.kind === "audit");
    // The raise needs its own line: an operator reading the log has to be able to
    // tell a ceiling that was corrected from one that was obeyed, and inferring
    // that from the footprint is exactly the kind of reading this log exists to
    // replace.
    const raised = audits.find((event) => event.decision === "allowed" && event.reason.includes("write budget raised"));
    assert.ok(raised, `expected a raise audit event, got ${JSON.stringify(audits)}`);
    const denied = audits.find((event) => event.decision === "denied" && event.reason.includes("write budget"));
    assert.ok(denied, `expected a write-budget refusal audit event, got ${JSON.stringify(audits)}`);
  });

  // The other half of the boundary, and the whole reason `provisionalCeiling`
  // exists: a gene's number is a commitment, not a guess. Hitting it is the real
  // failure — that is what the gene's score reads and what the next mint's
  // statistic corrects — so a gene-applied round gets no raise at all.
  it("gives a gene-applied round no raise, because a chosen number is a commitment", async () => {
    const first = join(fixture.workspaceRoot, "committed.txt");
    const second = join(fixture.workspaceRoot, "committed2.txt");
    await writeFile(first, "keep\n", "utf8");
    await writeFile(second, "keep\n", "utf8");

    const geneStore = new GeneStore(join(fixture.root, "gene-committed.jsonl"));
    const minted = mintGene({
      name: "committed", intent: "research", signalsMatch: ["改一下文件"], preconditions: [],
      strategy: [{ kind: "act", text: "改" }, { kind: "verify", text: "查" }],
      constraints: { maxFiles: 1, forbiddenPaths: [] },
      validation: ["npm.cmd test"], avoid: [],
    });
    await geneStore.appendGene(minted);

    const store = new SessionStore({ root: fixture.storeRoot });
    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({
        steps: [
          {
            content: "",
            toolCalls: [
              call("edit_file", { path: "committed.txt", content: "a\nb\nc\n" }, "committed_1"),
              call("edit_file", { path: "committed2.txt", content: "d\n" }, "committed_2"),
            ],
          },
          { content: "done" },
        ],
      }),
      store, sessionId: "budget-committed", home: fixture.home, workspaceRoot: fixture.workspaceRoot,
      geneStore, cycleStore: new CycleStore(join(fixture.root, "cycles-gene-committed.jsonl")),
      maxWriteFiles: 1,
      tools: new ToolRegistry([createEditFileTool()]),
      approve: async () => true,
    });

    const result = await runtime.send("改一下文件");
    assert.equal(result.appliedGene?.address, minted.address, "the round must actually run under the gene");
    assert.equal(await readFile(first, "utf8"), "a\nb\nc\n", "the write inside the declared number ran");
    assert.equal(await readFile(second, "utf8"), "keep\n", "the ceiling the gene chose was not corrected mid-round");
    assert.equal(result.budget.filesWrittenLimit, 1, "the gene's own number, uncorrected — a commitment, not an estimate");
    assert.ok(
      result.evaluation.evidence.some((line) => line === "budgetRefusals=1"),
      `expected the breach to be recorded as a lost write, got ${JSON.stringify(result.evaluation.evidence)}`,
    );
  });

  it("charges a performed write and reports it against the budget", async () => {
    const target = join(fixture.workspaceRoot, "charged.txt");
    await writeFile(target, "old\n", "utf8");
    const result = await runWithTools(
      [
        { content: "", toolCalls: [call("edit_file", { path: "charged.txt", content: "new\n" })] },
        { content: "done" },
      ],
      { sessionId: "budget-charge" },
    );
    assert.equal(await readFile(target, "utf8"), "new\n");
    assert.equal(result.budget.filesWritten, 1);
    assert.equal(result.budget.linesWritten, 1);
    assert.equal(result.budget.filesWrittenLimit, 3);
  });

  it("gives a gene exactly the budget it declared, below the default as well as above", async () => {
    const first = join(fixture.workspaceRoot, "gene-bounded.txt");
    const second = join(fixture.workspaceRoot, "gene-bounded2.txt");
    await writeFile(first, "keep\n", "utf8");
    await writeFile(second, "keep\n", "utf8");

    const geneStore = new GeneStore(join(fixture.root, "gene-budget.jsonl"));
    const minted = mintGene({
      name: "tight", intent: "research", signalsMatch: ["改一下文件"], preconditions: [],
      strategy: [{ kind: "act", text: "改" }, { kind: "verify", text: "查" }],
      constraints: { maxFiles: 1, forbiddenPaths: [] },
      validation: ["npm.cmd test"], avoid: [],
    });
    await geneStore.appendGene(minted);

    const store = new SessionStore({ root: fixture.storeRoot });
    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({
        steps: [
          {
            content: "",
            toolCalls: [
              call("edit_file", { path: "gene-bounded.txt", content: "a\nb\nc\n" }, "bounded_1"),
              call("edit_file", { path: "gene-bounded2.txt", content: "d\n" }, "bounded_2"),
            ],
          },
          { content: "done" },
        ],
      }),
      store, sessionId: "gene-bounded", home: fixture.home, workspaceRoot: fixture.workspaceRoot,
      geneStore, cycleStore: new CycleStore(join(fixture.root, "cycles-gene-bounded.jsonl")),
      // The runtime default allows 3 files. The gene asks for 1 and gets 1.
      maxWriteFiles: 3,
      tools: new ToolRegistry([createEditFileTool()]),
      approve: async () => true,
    });

    const result = await runtime.send("改一下文件");
    assert.equal(result.appliedGene?.address, minted.address);
    // ⚠️ Inverted from "but never narrow it below the default" (甲). A gene's
    // number is a commitment, so it is enforced as written — including downward,
    // which is the only direction that makes "this gene was sized wrong"
    // observable at all.
    assert.equal(result.budget.filesWrittenLimit, 1, "the gene's 1, not the runtime default's 3");
    // The refusal is checked before the tool runs, so the second file is untouched.
    // That refusal is exactly the evidence 戊 re-measures this gene's number from,
    // and under 甲 it could never be produced: the round was quietly handed the
    // default 3 and the gene's own number was never tested.
    assert.equal(await readFile(first, "utf8"), "a\nb\nc\n");
    assert.equal(await readFile(second, "utf8"), "keep\n");
  });

  it("classifies an exhausted write budget as a budget failure", () => {
    const error = new WriteBudgetError("cycle file budget exhausted");
    assert.equal(error.name, "WriteBudgetError");
  });
});

// D127: the budget is a measurement, not a guess. Every guard `distill.ts` minted
// used to carry a hardcoded file count — a number nobody derived from anything —
// and a round that exceeded it lost its success, so the library learned "this
// strategy failed" from what was really "this strategy was given too little room".
//
// ⚠️ One axis. The estimator used to take a median over lines as well. Lines are
// no longer a budget — they are journaled as blast radius and not estimated — so
// every case below is stated in files.
describe("measuredBudget", () => {
  const obs = (filesWritten: number, linesWritten: number, budgetRefusals = 0, ceilingFiles?: number) => ({
    filesWritten, linesWritten, budgetRefusals, ...(ceilingFiles === undefined ? {} : { ceilingFiles }),
  });

  it("returns the fallback untouched when nothing has been measured", () => {
    // A new request kind is a real cold start, not a zero. Returning 0 files
    // would refuse the first write of the next round.
    assert.deepEqual(measuredBudget([]), { ...COLD_START_BUDGET });
    assert.deepEqual(measuredBudget([], { maxFiles: 9 }), { maxFiles: 9 });
  });

  it("falls below the fallback, and stops at the floor rather than at a guess", () => {
    // ⚠️ This was the opposite assertion until the estimator took the median. A
    // floor pinned to the fallback meant a gene could never be narrower than a
    // number nobody had measured — so a demand that needed 5 and drifted up to 10
    // could be raised but never brought back. The floor now does one job only:
    // stop a zero (`MIN_MEASURED_BUDGET`).
    assert.deepEqual(measuredBudget([obs(2, 10), obs(2, 10), obs(2, 10)], { maxFiles: 9 }), { maxFiles: 2 }, "2, not the fallback's 9: a measurement beats a guess in both directions");

    // A row that recorded nothing at all is not a sample of zero: it is a row from
    // before the footprint was journaled (`gene-store.ts` promises that reading).
    // Here the two empty rounds drop out and only the one that wrote speaks.
    assert.deepEqual(measuredBudget([obs(0, 0), obs(1, 2), obs(0, 0)]), { maxFiles: 1 });

    // The floor itself, reached by a row that *is* a measurement because it names
    // the ceiling it ran under — and the answer still cannot come out at zero.
    assert.deepEqual(measuredBudget([obs(0, 0, 0, 0)]), { ...MIN_MEASURED_BUDGET });
  });

  it("sizes uncensored observations at their median, not at their top", () => {
    assert.equal(measuredBudget([obs(4, 90), obs(5, 120), obs(3, 70)]).maxFiles, 4, "the middle of 3, 4 and 5");
  });

  it("⚠️ adds back the room a refusal proved was wanted, instead of re-deriving the cap", () => {
    // The load-bearing case. A refused round records what it *reached*, and that
    // value IS the cap — so reading it as demand re-derives the same too-small
    // budget on every pass, and the budget can never lift. A fixed point that
    // measures nothing.
    assert.equal(measuredBudget([obs(1, 20, 1), obs(1, 20, 1), obs(1, 20, 1)]).maxFiles, 2, "one refused write proves a second file was wanted");
  });

  it("lets one outsized round widen the budget without defining it (median, not max)", () => {
    const typical = Array.from({ length: 19 }, () => obs(3, 40));
    assert.equal(measuredBudget([...typical, obs(50, 900)]).maxFiles, 3, "a single 50-file round must not become the budget");
  });

  it("⚠️ lifts the ceiling off the old one when demand exceeds it, settling on the median", () => {
    // The case the p95 estimator got wrong, in the operator's own arithmetic.
    // Three rounds refused at a ceiling of 6 prove each of them wanted 7
    // (`reached + 1`). The ceiling they ran under enters **once** — added three
    // times it would put 6 in the majority and leave the median sitting on it,
    // which is the fixed point this estimator exists to escape.
    assert.equal(measuredBudget([obs(6, 60, 1, 6), obs(6, 60, 1, 6), obs(6, 60, 1, 6)]).maxFiles, 7, "samples are {6, 7, 7, 7}; the median is 7");
  });

  it("⚠️ pulls the ceiling back down when demand falls, which p95 could never do", () => {
    // The other half, and the whole reason the ceiling is a sample: a gene that
    // ran under 7 and was then only ever asked for 4, 4 and 3 must be tightened
    // to 4. Under p95 it stayed 7 for good, because a tail quantile has nothing
    // pulling it back down — the estimate could only ratchet upward.
    assert.equal(measuredBudget([obs(4, 40, 0, 7), obs(4, 40, 0, 7), obs(3, 30, 0, 7)]).maxFiles, 4, "samples are {7, 4, 4, 3}; the median is 4");
  });
});
