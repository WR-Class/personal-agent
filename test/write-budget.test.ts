import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { blastTier, blastWeight, budgetFor, chargeWrite, checkWrite, hardStopAt, measuredBudget, COLD_START_BUDGET, MIN_MEASURED_BUDGET, GLOBAL_LINE_CAP, OVERRUN_RATIO, HARD_STOP_RATIO, OVERRUN_WEIGHT, HARD_STOP_WEIGHT, ABSOLUTE_HEADROOM, readWriteAttempt, WriteBudgetError, countsTowardWriteBudget, isJournalPath } from "../src/write-budget.ts";
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

  it("refuses the write that would cross the hard stop, and names both the stop and the number it came from", () => {
    const one = chargeWrite(EMPTY, { tool: "edit_file", path: "a.ts", lines: 1 }, 0);
    const two = chargeWrite(one, { tool: "edit_file", path: "b.ts", lines: 1 }, 1);
    const decision = checkWrite(two, { tool: "edit_file", path: "c.ts", lines: 1 }, { maxFiles: 1, forbiddenPaths: [] });
    assert.equal(decision.allowed, false);
    // ⚠️ D151: no longer "file budget exhausted" at the declared number. The only
    // refusal left is the ladder's stop, and the message must say so — an operator
    // reading a refusal needs to know whether a number was hit or a number was
    // blown past, because only the second is a mistake worth correcting.
    // ⚠️ D152: and it now names the floor as well as the ratio, because at small
    // declared values it is the floor that sets the stop, not the 1.5x.
    assert.match(decision.reason!, /hard stop/);
    assert.match(decision.reason!, /is the limit for a declared 1/);
    assert.match(decision.reason!, /1\.5x, never less than \+2/);
    assert.match(decision.reason!, /c\.ts/);
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

  it("allows the same file again, and stops the write that would cross the floored stop", () => {
    const one = chargeWrite(EMPTY, { tool: "edit_file", path: "a.ts", lines: 10 }, 0);
    assert.equal(checkWrite(one, { tool: "edit_file", path: "a.ts", lines: 0 }, { maxFiles: 1, forbiddenPaths: [] }).allowed, true, "the same file again is not a second file");
    // ⚠️ D152: a declared 1 now reaches two files. The absolute headroom floors the
    // stop above the ratio at small values — without it the ladder collapsed here
    // into "one file, then stop", which is the wall it was built to remove.
    const two = chargeWrite(one, { tool: "edit_file", path: "b.ts", lines: 1 }, 1);
    assert.equal(checkWrite(two, { tool: "edit_file", path: "c.ts", lines: 1 }, { maxFiles: 1, forbiddenPaths: [] }).allowed, false);
  });

  it("still charges an anonymous write, so malformed arguments cannot buy budget", () => {
    const one = chargeWrite(EMPTY, { tool: "edit_file", path: null, lines: null }, 0);
    const two = chargeWrite(one, { tool: "edit_file", path: null, lines: null }, 1);
    assert.equal(two.files.length, 2, "each unreadable target takes its own slot");
    const decision = checkWrite(two, { tool: "edit_file", path: null, lines: null }, { maxFiles: 1, forbiddenPaths: [] });
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
    const one = chargeWrite(EMPTY, { tool: "edit_file", path: "a.ts", lines: 0 }, 0);
    const full = chargeWrite(one, { tool: "edit_file", path: "b.ts", lines: 0 }, 1);
    const budget = { maxFiles: 1, forbiddenPaths: [] as readonly string[] };
    assert.equal(checkWrite(full, { tool: "edit_file", path: "c.ts", lines: 0 }, budget).allowed, false);
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

// ⚠️ Deleted with the raise (D151): `describe("raising an under-sized ceiling")`.
// The four cases there all described correcting a refusal that happened at the
// declared number — the budget a round needs after the ceiling refused one of its
// writes, a policy refusal that no amount of room lifts, and an attempt that
// already fits. Nothing refuses at the declared number any more, so there is no
// refusal for a raise to answer and the whole mechanism is gone rather than
// widened. What replaced it is the ladder below.

describe("the blast-radius ladder", () => {
  // The operator's arithmetic, written out before the code was: with a declared
  // 20, 25 is the last round that is merely over, 26 is the first that is charged,
  // and 30 is the first write refused. Stated as a table because an off-by-one in
  // a comparison here silently restores the wall the ladder exists to remove.
  const N = 20;
  const cases: ReadonlyArray<readonly [number, string]> = [
    [20, "within"], [21, "exceeded"], [25, "exceeded"],
    [26, "overrun"], [28, "overrun"], [29, "overrun"],
    [30, "hard_stop"], [40, "hard_stop"],
  ];

  it("labels the operator's own table, boundary values included", () => {
    for (const [files, tier] of cases) {
      assert.equal(blastTier(files, N), tier, `${files} of a declared ${N} must read as ${tier}`);
    }
  });

  it("pins the ratios themselves, so a silent retune of either is a failing test", () => {
    assert.equal(OVERRUN_RATIO, 1.3);
    assert.equal(HARD_STOP_RATIO, 1.5);
  });

  it("⚠️ floors the stop so the ladder cannot collapse at small declared values", () => {
    // The tightest numbers the library can mint (`COLD_START_BUDGET` /
    // `MIN_MEASURED_BUDGET`). A pure ratio has no whole unit to stand on down
    // here — 1.3x and 1.5x of 1 are 1.3 and 1.5, so both bands between the
    // thresholds are empty and the ladder degenerated into "one file, then stop":
    // the wall it was built to remove, wearing a new name.
    //
    // The floor is two files of headroom, and what it costs is stated in the
    // constant: at declared values below 4 the stop is no longer exactly 1.5x.
    assert.equal(ABSOLUTE_HEADROOM, 2);
    assert.equal(hardStopAt(1), 3, "not 1.5 — the floor wins");
    assert.equal(hardStopAt(2), 4, "not 3 — the floor wins");
    assert.equal(hardStopAt(3), 5, "not 4.5 — the floor still wins");
    assert.equal(hardStopAt(4), 6, "from here the ratio wins");
    assert.equal(hardStopAt(20), 30);

    const first = chargeWrite(EMPTY, { tool: "edit_file", path: "a.ts", lines: 1 }, 0);
    const second = chargeWrite(first, { tool: "edit_file", path: "b.ts", lines: 1 }, 1);
    const budget = { maxFiles: 1, forbiddenPaths: [] };
    assert.equal(checkWrite(second, { tool: "edit_file", path: "c.ts", lines: 1 }, budget).allowed, false, "a declared 1 still stops — at three, not at two");
  });

  it("⚠️ makes the 0.4 tier reachable only where the floor binds", () => {
    // A declared 20 can reach at most 29 files before the write is refused, so its
    // worst ratio is 1.45 and it can never enter the 1.5x tier. The 0.4 weight is
    // therefore a small-number tier, and that is coherent rather than accidental:
    // the floor gives those rounds absolute room and charges them more, relatively,
    // for using it.
    assert.equal(blastTier(hardStopAt(20) - 1, 20), "overrun", "29 of 20 is 1.45x, the worst a declared 20 can do");
    assert.equal(blastTier(hardStopAt(1) - 1, 1), "hard_stop", "2 of 1 is 2x, and the floor is what let it get there");
  });

  it("never refuses a write at the declared number, however tight the number is", () => {
    // The whole point of the ladder. A round that declared 2 and is writing its
    // second file is *inside* its number — under the wall this was the write that
    // got refused.
    const one = chargeWrite(EMPTY, { tool: "edit_file", path: "a.ts", lines: 1 }, 0);
    const budget = { maxFiles: 2, forbiddenPaths: [] };
    assert.equal(checkWrite(one, { tool: "edit_file", path: "b.ts", lines: 1 }, budget).allowed, true, "the second of a declared two is not an overrun");
    const two = chargeWrite(one, { tool: "edit_file", path: "b.ts", lines: 1 }, 1);
    assert.equal(checkWrite(two, { tool: "edit_file", path: "c.ts", lines: 1 }, budget).allowed, true, "nor is the third — the floor put the stop at four");
    const three = chargeWrite(two, { tool: "edit_file", path: "c.ts", lines: 1 }, 2);
    assert.equal(checkWrite(three, { tool: "edit_file", path: "d.ts", lines: 1 }, budget).allowed, false);
  });

  it("refuses exactly at the hard stop and not one file earlier", () => {
    const at = (n: number) => ({ files: Array.from({ length: n }, (_, i) => `f${i}.ts`), lines: n });
    const budget = { maxFiles: 20, forbiddenPaths: [] };
    assert.equal(checkWrite(at(28), { tool: "edit_file", path: "next.ts", lines: 1 }, budget).allowed, true, "29 files is still under the 30 stop");
    const stopped = checkWrite(at(29), { tool: "edit_file", path: "next.ts", lines: 1 }, budget);
    assert.equal(stopped.allowed, false, "the thirtieth file is the stop");
    assert.match(stopped.reason!, /hard stop/);
    assert.match(stopped.reason!, /is the limit for a declared 20/);
  });

  it("pins the weights, and that the two uncharged tiers are genuinely free", () => {
    assert.equal(OVERRUN_WEIGHT, 0.7);
    assert.equal(HARD_STOP_WEIGHT, 0.4);
    assert.equal(blastWeight("within"), 1);
    assert.equal(blastWeight("exceeded"), 1, "labelled but deliberately not charged for — the reference's own split");
    assert.equal(blastWeight("overrun"), 0.7);
    assert.equal(blastWeight("hard_stop"), 0.4);
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

  // ⚠️ Replaces "raises a provisional file ceiling once, then refuses the write
  // after that". There is no raise any more: the declared number does not refuse,
  // so the first refusal the raise used to correct cannot happen. The two tests
  // below are what the ladder does instead — the writes below the stop all land,
  // and the one that would cross the stop is the only thing refused.
  it("lets every write below the hard stop land, and refuses only the one that crosses it", async () => {
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
      // A declared 1 stops at 3 — the floor, not the 1.5x — so the second file
      // lands and the third does not.
      maxWriteFiles: 1,
      tools: new ToolRegistry([createEditFileTool()]),
      approve: async () => true,
    });

    const result = await runtime.send("改三个文件");
    assert.equal(await readFile(join(fixture.workspaceRoot, "one.txt"), "utf8"), "w0\n");
    assert.equal(await readFile(join(fixture.workspaceRoot, "two.txt"), "utf8"), "w1\n", "the declared number itself refuses nothing now");
    assert.equal(await readFile(join(fixture.workspaceRoot, "three.txt"), "utf8"), "keep2\n", "the write that would cross the floored stop is the only refusal left");
    assert.equal(result.budget.filesWritten, 2);
    assert.equal(result.budget.filesWrittenLimit, 1, "the number the round declared, unchanged — nothing widens it now");
    // D127 still holds: a refusal means the tool never ran, so it is not a tool
    // failure and does not by itself move the verdict.
    assert.equal(result.evaluation.status, "success");
    assert.ok(
      result.evaluation.evidence.some((line) => line === "budgetRefusals=1"),
      `expected exactly one standing refusal in evidence, got ${JSON.stringify(result.evaluation.evidence)}`,
    );
  });

  it("⚠️ charges an overrun: past 1.3x the round's success is discounted, not denied", async () => {
    // The cost the ladder puts where the wall used to be. A declared 3 that
    // reaches 4 is 1.33x — past the operator's 1.3x threshold and below the 1.5x
    // stop — so all four writes land and nothing is refused.
    //
    // ⚠️ D152: the round is still a `success`. D151 had it downgraded to `partial`
    // as well as weighted, which charged one overrun twice; the operator asked for
    // a graded cost, and the weight is where a graded cost belongs. The verdict
    // answers "did the round work", and it did.
    const names = ["over-a.txt", "over-b.txt", "over-c.txt", "over-d.txt"];
    for (const name of names) await writeFile(join(fixture.workspaceRoot, name), "keep\n", "utf8");

    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({
        steps: [
          { content: "", toolCalls: names.map((name, i) => call("edit_file", { path: name, content: `w${i}\n` }, `over_${i}`)) },
          { content: "done" },
        ],
      }),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: "budget-overrun", home: fixture.home, workspaceRoot: fixture.workspaceRoot,
      maxWriteFiles: 3,
      tools: new ToolRegistry([createEditFileTool()]),
      approve: async () => true,
    });

    const result = await runtime.send("改四个文件");
    assert.equal(result.budget.filesWritten, 4, "all four landed — that is the whole point of moving the wall");
    assert.equal(result.evaluation.status, "success", "the round worked; only its price changed");
    assert.ok(
      result.evaluation.evidence.some((line) => line === "blastRadius=overrun"),
      `expected the tier in evidence, got ${JSON.stringify(result.evaluation.evidence)}`,
    );
    assert.equal(result.evaluation.failureClass, null, "nothing broke, so it is not a failure and not a strategy verdict");
  });

  it("⚠️ folds the weight into the gene's own record, as a fraction of a success", async () => {
    // The end-to-end of D152, and the assertion that matters most: the weight is
    // not merely written down, it is READ. A weight that is computed and then
    // never folded looks identical to a correct one until something asks the gene
    // how it has been doing — which is the whole defect this round exists to
    // avoid, one layer over from where it was fixed.
    const names = ["frac-a.txt", "frac-b.txt", "frac-c.txt", "frac-d.txt"];
    for (const name of names) await writeFile(join(fixture.workspaceRoot, name), "keep\n", "utf8");

    const geneStore = new GeneStore(join(fixture.root, "fraction-genes.jsonl"));
    const minted = mintGene({
      name: "fraction", intent: "research", signalsMatch: ["改一下文件"], preconditions: [],
      strategy: [{ kind: "act", text: "改" }, { kind: "verify", text: "查" }],
      constraints: { maxFiles: 3, forbiddenPaths: [] },
      validation: ["npm.cmd test"], avoid: [],
    });
    await geneStore.appendGene(minted);

    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({
        steps: [
          { content: "", toolCalls: names.map((name, i) => call("edit_file", { path: name, content: `w${i}\n` }, `frac_${i}`)) },
          { content: "done" },
        ],
      }),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: "budget-fraction", home: fixture.home, workspaceRoot: fixture.workspaceRoot,
      geneStore, cycleStore: new CycleStore(join(fixture.root, "cycles-fraction.jsonl")),
      tools: new ToolRegistry([createEditFileTool()]),
      approve: async () => true,
    });

    const result = await runtime.send("改一下文件");
    assert.equal(result.appliedGene?.address, minted.address, "the round must run under the gene");
    assert.equal(result.budget.filesWritten, 4, "the declared 3 did not refuse the fourth write");
    assert.equal(result.evaluation.status, "success");

    const entry = (await geneStore.state()).genes.get(minted.address);
    assert.equal(entry?.expression.attempts, 1, "the attempt counts in full");
    assert.equal(entry?.expression.successes, 0.7, "but the success is discounted to 0.7 — not zero, and not one");
    assert.equal(entry?.expression.streak, 0, "an overrun is not a strategy failure, so it does not march toward quarantine");
  });

  it("journals the ceiling the round ran under, so the estimate can fall later", async () => {
    // The wiring half. `measuredBudget` can only weigh the ceiling against the
    // demand if the round records the ceiling at all — without it the estimator
    // has demands alone, which can rise but has nothing pulling them back down.
    // That is the one-way ratchet, one layer below the one already removed.
    //
    // ⚠️ D151: the ceiling is now simply the number the round declared. It used to
    // be the number the round *ended* under, because the raise could change it;
    // nothing changes it now, which is what makes this field a record of the
    // strategy's own claim rather than of the runtime's correction to it.
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
      maxWriteFiles: 2, geneStore,
      tools: new ToolRegistry([createEditFileTool()]),
      approve: async () => true,
    });

    const result = await runtime.send("改两个文件");
    assert.equal(result.budget.filesWrittenLimit, 2, "the declared number, not a widened one");

    const facts = await geneStore.geneLessSuccesses();
    const fact = facts.find((entry) => entry.filesWritten === 2);
    assert.ok(fact, `expected this round in the induction archive, got ${JSON.stringify(facts)}`);
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
      // One file allowed, three attempted: the second and third are both past the
      // 1.5x stop, so both are refused. Nothing widens the number any more.
      maxWriteFiles: 1,
      tools: new ToolRegistry([createEditFileTool()]),
      approve: async () => true,
    });
    await runtime.send("改文件");

    const { events } = await store.inspect("budget-audit");
    const audits = events.filter((event): event is AuditEvent => event.kind === "audit");
    const denied = audits.find((event) => event.decision === "denied" && event.reason.includes("write budget"));
    assert.ok(denied, `expected a write-budget refusal audit event, got ${JSON.stringify(audits)}`);
    // ⚠️ D151: the counterpart assertion is inverted. This test used to require a
    // "write budget raised" line, because a refused write was corrected once. That
    // mechanism is gone, and the log must not still be able to claim a correction
    // that nothing performs — an audit line for a mechanism that cannot fire is
    // the most expensive kind of stale record, because it is read as history.
    assert.equal(
      audits.find((event) => event.reason.includes("write budget raised")),
      undefined,
      "nothing raises a budget any more, so no audit line may say one was",
    );
  });

  // ⚠️ D151: this used to be "no raise, because a chosen number is a commitment".
  // There is no raise for anyone now, so the thing worth pinning is what replaced
  // it — a gene-applied round is bounded by its own number through the ladder, and
  // the ladder's stop is measured from *that* number, not from the runtime default.
  it("bounds a gene-applied round by the gene's own number, not by the runtime default", async () => {
    const first = join(fixture.workspaceRoot, "committed.txt");
    const second = join(fixture.workspaceRoot, "committed2.txt");
    const third = join(fixture.workspaceRoot, "committed3.txt");
    await writeFile(first, "keep\n", "utf8");
    await writeFile(second, "keep\n", "utf8");
    await writeFile(third, "keep\n", "utf8");

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
              call("edit_file", { path: "committed3.txt", content: "e\n" }, "committed_3"),
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
    assert.equal(await readFile(second, "utf8"), "d\n", "and the one past it — it is the floored stop that refuses, not the declared number");
    assert.equal(await readFile(third, "utf8"), "keep\n", "the third is where the floored stop sits");
    assert.equal(result.budget.filesWrittenLimit, 1, "the gene's own number — the ladder is measured from it, not from the default 3");
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
    const third = join(fixture.workspaceRoot, "gene-bounded3.txt");
    await writeFile(first, "keep\n", "utf8");
    await writeFile(second, "keep\n", "utf8");
    await writeFile(third, "keep\n", "utf8");

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
              call("edit_file", { path: "gene-bounded3.txt", content: "e\n" }, "bounded_3"),
            ],
          },
          { content: "done" },
        ],
      }),
      store, sessionId: "gene-bounded", home: fixture.home, workspaceRoot: fixture.workspaceRoot,
      geneStore, cycleStore: new CycleStore(join(fixture.root, "cycles-gene-bounded.jsonl")),
      // The runtime default allows 3 files. The gene asks for 1, so the ladder's
      // stop is measured from 1 — floored to 3 — and not from the default's 4.5.
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
    // The refusal is checked before the tool runs, so the third file is untouched.
    // That refusal is exactly the evidence 戊 re-measures this gene's number from,
    // and under 甲 it could never be produced: the round was quietly handed the
    // default 3 and the gene's own number was never tested.
    assert.equal(await readFile(first, "utf8"), "a\nb\nc\n");
    assert.equal(await readFile(second, "utf8"), "d\n", "the second lands — the floored stop, not the declared 1, is what refuses");
    assert.equal(await readFile(third, "utf8"), "keep\n");
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
