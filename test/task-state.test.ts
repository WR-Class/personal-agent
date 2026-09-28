import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { afterEach, describe, it } from "node:test";
import { SessionStore } from "../src/session-store.ts";
import { assessTaskState, assertNotWeakened, WeakenedTaskStateError } from "../src/task-state.ts";
import type { TaskStateStep } from "../src/task-state.ts";
import type { GeneValidation } from "../src/gene.ts";
import type { RoundEvidence } from "../src/validation.ts";
import { createTestFixture } from "./fixtures.ts";

const fixture = await createTestFixture("task-state");
const store = new SessionStore({ root: fixture.storeRoot });

/** Evidence as the journal would report it: what was written and what was called. */
const EVIDENCE: RoundEvidence = {
  filesWritten: ["src/a.ts", "test/a.test.ts"],
  tools: ["read_file", "create_file", "create_file"],
};

const files = (paths: readonly string[]): GeneValidation => ({ kind: "files-written", paths });
const used = (tool: string, times?: number): GeneValidation =>
  times === undefined ? { kind: "tool-used", tool } : { kind: "tool-used", tool, times };

let created = 0;
async function session(): Promise<string> {
  const id = `task-state-${created++}`;
  await store.create(id);
  return id;
}

afterEach(() => {
  // Nothing to undo: every test uses its own session id, and fixtures are retained
  // for inspection by design.
});

describe("task state: completion is computed, never stored", () => {
  it("has no `done` field to write, and ignores one smuggled in", () => {
    // A step carrying `done: true` must not become complete: the only thing that
    // decides completion is the claim against evidence.
    const steps = [{ text: "写实现", claim: files(["src/never.ts"]), done: true }] as unknown as readonly TaskStateStep[];
    const assessment = assessTaskState(steps, EVIDENCE);
    assert.equal(assessment.complete, false);
    assert.equal(assessment.steps[0]!.outcome, "unmet");
    assert.equal(assessment.failed.length, 1);
  });

  it("reports a met claim as met without any gene being involved", () => {
    // The D60 trap: runtime.ts:822 gates gene claims behind `applied ?`. With an
    // empty gene library that gate would leave every step undecided forever while
    // looking like it worked. assessTaskState takes evidence directly, so this
    // test fails if the gate is ever copied in.
    const assessment = assessTaskState([{ text: "写实现与测试", claim: files(["src/a.ts", "test/a.test.ts"]) }], EVIDENCE);
    assert.equal(assessment.steps[0]!.outcome, "met");
    assert.equal(assessment.complete, true);
    assert.deepEqual([...assessment.unknowns], []);
    assert.deepEqual([...assessment.failed], []);
  });

  it("treats an unverifiable claim as unknown, never as complete", () => {
    // "Run the tests" is the most natural acceptance criterion for a coding task,
    // and it is exactly the kind this runtime cannot decide. Saying so is the
    // point; counting it as met would manufacture proof.
    const assessment = assessTaskState([{ text: "跑测试", claim: { kind: "command", command: "npm.cmd test" } }], EVIDENCE);
    assert.equal(assessment.steps[0]!.outcome, "unverifiable");
    assert.equal(assessment.complete, false);
    assert.equal(assessment.unknowns.length, 1);
    assert.match(assessment.unknowns[0]!, /无法判定/);
    assert.deepEqual([...assessment.failed], []);
  });

  it("counts a step with no criterion as an unknown, not as progress", () => {
    const assessment = assessTaskState([{ text: "想清楚要做什么" }], EVIDENCE);
    assert.equal(assessment.complete, false);
    assert.equal(assessment.unknowns.length, 1);
    assert.match(assessment.unknowns[0]!, /缺验收条件/);
  });

  it("refuses to call an empty task complete", () => {
    assert.equal(assessTaskState([], EVIDENCE).complete, false);
  });

  it("requires every step to be met, so one unmet step blocks completion", () => {
    const assessment = assessTaskState(
      [
        { text: "写实现", claim: files(["src/a.ts", "test/a.test.ts"]) },
        { text: "读旧代码", claim: used("delete_file") },
      ],
      EVIDENCE,
    );
    assert.equal(assessment.complete, false);
    assert.equal(assessment.failed.length, 1);
    assert.match(assessment.failed[0]!, /未达成/);
  });
});

describe("task state: claims are monotone", () => {
  it("refuses to delete a step, which would drop its criterion", () => {
    const previous = [{ text: "一", claim: used("read_file") }, { text: "二", claim: used("create_file") }];
    assert.throws(() => assertNotWeakened(previous, [previous[0]!]), WeakenedTaskStateError);
    assert.throws(() => assertNotWeakened(previous, [{ text: "一", claim: used("read_file") }]), /删除步骤/);
  });

  it("refuses to remove a criterion while keeping the step", () => {
    assert.throws(() => assertNotWeakened([{ text: "一", claim: used("read_file") }], [{ text: "一" }]), /验收条件被移除/);
  });

  it("refuses to change a criterion's kind, since kinds have no strength order", () => {
    assert.throws(
      () => assertNotWeakened([{ text: "一", claim: files(["src/a.ts"]) }], [{ text: "一", claim: used("read_file") }]),
      /没有强度序/,
    );
  });

  it("refuses to grow a files-written claim, which would turn a failure into a pass", () => {
    // The operator approved "paths growth counts as strengthening". Reading
    // validation.ts:56-70 showed it does not: the kind is bidirectional set
    // equality, so [a] and [a,b] are incomparable, and when the round wrote both
    // files the old claim fails while the new one passes.
    const previous = [{ text: "一", claim: files(["src/a.ts"]) }];
    assert.throws(() => assertNotWeakened(previous, [{ text: "一", claim: files(["src/a.ts", "src/b.ts"]) }]), /paths 不可变/);
    assert.throws(() => assertNotWeakened(previous, [{ text: "一", claim: files(["src/b.ts"]) }]), /paths 不可变/);
    // Same set, different order, is the same claim.
    assert.doesNotThrow(() => assertNotWeakened(
      [{ text: "一", claim: files(["src/a.ts", "src/b.ts"]) }],
      [{ text: "一", claim: files(["src/b.ts", "src/a.ts"]) }],
    ));
  });

  it("refuses to lower or drop a tool-used lower bound, and allows raising it", () => {
    const previous = [{ text: "一", claim: used("create_file", 2) }];
    assert.throws(() => assertNotWeakened(previous, [{ text: "一", claim: used("create_file", 1) }]), /次数下限从 2 降到了 1/);
    assert.throws(() => assertNotWeakened(previous, [{ text: "一", claim: used("create_file") }]), /去掉了次数下限/);
    assert.throws(() => assertNotWeakened(previous, [{ text: "一", claim: used("read_file", 2) }]), /换一个工具是换一个条件/);
    assert.doesNotThrow(() => assertNotWeakened(previous, [{ text: "一", claim: used("create_file", 3) }]));
    assert.doesNotThrow(() => assertNotWeakened(previous, [{ text: "一", claim: used("create_file", 2) }]));
    // Adding a bound where there was none is strengthening: `times` is a lower bound.
    assert.doesNotThrow(() => assertNotWeakened([{ text: "一", claim: used("create_file") }], [{ text: "一", claim: used("create_file", 1) }]));
  });

  it("refuses to rewrite a command criterion", () => {
    const previous = [{ text: "一", claim: { kind: "command", command: "npm.cmd test" } as GeneValidation }];
    assert.throws(
      () => assertNotWeakened(previous, [{ text: "一", claim: { kind: "command", command: "npm.cmd run build" } }]),
      /恒为 unverifiable/,
    );
    assert.doesNotThrow(() => assertNotWeakened(previous, previous));
  });

  it("allows appending steps and rewriting prose, which carry no authority", () => {
    const previous = [{ text: "旧的说法", claim: used("read_file") }];
    assert.doesNotThrow(() => assertNotWeakened(previous, [
      { text: "完全不同的说法", claim: used("read_file") },
      { text: "新增的一步" },
    ]));
  });

  it("allows adding a criterion where a step had none", () => {
    assert.doesNotThrow(() => assertNotWeakened([{ text: "一" }], [{ text: "一", claim: used("read_file") }]));
  });

  it("does nothing when there was no previous state", () => {
    assert.doesNotThrow(() => assertNotWeakened(undefined, [{ text: "一" }]));
    assert.doesNotThrow(() => assertNotWeakened([], [{ text: "一" }]));
  });
});

describe("task state: the session log stores it", () => {
  it("round-trips every field, including each claim", () => {
    // The `audit` case in migrateEvent warns that a field not read explicitly
    // vanishes on the way back in. This is the test that would catch it.
    return (async () => {
      const id = await session();
      const steps: TaskStateStep[] = [
        { text: "写实现与测试", claim: files(["src/a.ts", "test/a.test.ts"]) },
        { text: "调用过读取", claim: used("read_file", 1) },
        { text: "跑测试", claim: { kind: "command", command: "npm.cmd test" } },
        { text: "只读不写", claim: { kind: "no-write" } },
        { text: "还没定验收条件" },
      ];
      const written = await store.appendTaskState(id, { state: "第一步做完了", steps });
      const read = await store.taskState(id);
      assert.equal(read?.kind, "task-state");
      assert.equal(read?.state, "第一步做完了");
      assert.equal(read?.atMessage, written.atMessage);
      assert.deepEqual(read!.steps.map((step) => step.text), steps.map((step) => step.text));
      assert.deepEqual([...read!.steps.map((step) => step.claim)], steps.map((step) => step.claim));
      assert.equal(read?.ignorable, true);
    })();
  });

  it("keeps every version in the log while the reader returns the latest", () => {
    return (async () => {
      const id = await session();
      await store.appendTaskState(id, { state: "第一版", steps: [{ text: "一", claim: used("read_file") }] });
      await store.appendTaskState(id, { state: "第二版", steps: [{ text: "一", claim: used("read_file") }, { text: "二" }] });
      const latest = await store.taskState(id);
      assert.equal(latest?.state, "第二版");
      assert.equal(latest?.steps.length, 2);
      const events = await store.read(id);
      assert.equal(events.filter((event) => event.kind === "task-state").length, 2);
    })();
  });

  it("refuses a later state that weakens an earlier one, and leaves the earlier intact", () => {
    return (async () => {
      const id = await session();
      await store.appendTaskState(id, { state: "一", steps: [{ text: "一", claim: used("create_file", 2) }] });
      await assert.rejects(
        () => store.appendTaskState(id, { state: "二", steps: [{ text: "一", claim: used("create_file", 1) }] }),
        WeakenedTaskStateError,
      );
      const latest = await store.taskState(id);
      assert.equal(latest?.state, "一");
      assert.deepEqual(latest?.steps[0]!.claim, used("create_file", 2));
    })();
  });

  it("records the observed message count rather than one supplied by the caller", () => {
    return (async () => {
      const id = await session();
      await store.appendMessage(id, { role: "user", content: "做一件事" });
      const event = await store.appendTaskState(id, { state: "开始了", steps: [] });
      assert.equal(event.atMessage, 1);
      await store.appendMessage(id, { role: "assistant", content: "好" });
      const second = await store.appendTaskState(id, { state: "还在做", steps: [] });
      assert.equal(second.atMessage, 2);
    })();
  });

  it("records state during an unfinished batch, because unlike a summary it replaces nothing", () => {
    // The obvious move is to copy appendSummary's refusal here. It does not
    // transfer, and the difference is load-bearing: a summary *replaces* what the
    // model sees, so summarizing an unanswered call freezes "an answer-shaped
    // summary of a question that was never resolved" into the prompt. A task-state
    // record replaces nothing — every message still replays, and the pending
    // result still arrives and is still shown — so the harm that guard exists to
    // prevent does not exist here.
    //
    // Copying it would have been fatal rather than merely wrong: this event is
    // written by a tool, whose own call is necessarily pending while it executes,
    // so the guard would refuse every write the tool ever attempted. Found by an
    // end-to-end test; no unit test of the store alone could have caught it.
    return (async () => {
      const id = await session();
      await store.appendMessage(id, {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "call-1", name: "read_file", arguments: JSON.stringify({ path: "x.txt" }) }],
      });
      const pending = await store.pendingTools(id);
      assert.equal(pending.length, 1);
      const written = await store.appendTaskState(id, {
        state: "第一步进行中",
        steps: [{ text: "一", claim: used("read_file") }],
      });
      assert.equal(written.steps.length, 1);
      // The unresolved call is still unresolved and still visible — nothing froze.
      assert.equal((await store.pendingTools(id)).length, 1);
      assert.equal((await store.taskState(id))?.state, "第一步进行中");
    })();
  });

  it("rejects an empty state block instead of storing a blank", () => {
    return (async () => {
      const id = await session();
      await assert.rejects(() => store.appendTaskState(id, { state: "   ", steps: [] }), /must not be empty/);
    })();
  });

  it("returns undefined for a session that never recorded state", async () => {
    assert.equal(await store.taskState(await session()), undefined);
  });

  it("is skipped, not fatal, when a reader meets an unknown ignorable kind", () => {
    // The forward-compatibility promise: an older reader meeting this kind skips
    // it and builds a prompt with no state block — longer than intended, not wrong.
    return (async () => {
      const id = await session();
      await store.appendTaskState(id, { state: "一", steps: [{ text: "一", claim: used("read_file") }] });
      // `append` validates the kind, so a record from a future build has to be
      // written the way that build would have written it: straight to the file.
      await appendFile(store.pathFor(id), `${JSON.stringify({
        v: 1, kind: "something-invented-later", ignorable: true, at: new Date().toISOString(), payload: "x",
      })}\n`, "utf8");
      const latest = await store.taskState(id);
      assert.equal(latest?.state, "一");
      const events = await store.read(id);
      assert.equal(events.some((event) => (event as { kind: string }).kind === "something-invented-later"), false);
      // The conversation is untouched: the skipped record is not a message.
      assert.equal((await store.history(id)).length, 0);
    })();
  });

  it("survives a compaction, which only replaces tool messages", async () => {
    const id = await session();
    await store.appendMessage(id, { role: "user", content: "做一件事" });
    await store.appendTaskState(id, { state: "开始了", steps: [{ text: "一", claim: used("read_file") }] });
    await store.appendSummary(id, { covers: 1, summary: "SUMMARY: 用户要做一件事" });
    const latest = await store.taskState(id);
    assert.equal(latest?.state, "开始了");
    assert.equal((await store.compaction(id))?.covers, 1);
  });
});
