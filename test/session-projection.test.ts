/**
 * Step ① of D72's order: the projection seam's Definition, plus the two kinds of
 * "absent" that must not be conflated.
 *
 * The load-bearing property is the one D60 already paid for. A feature that looks
 * like it works — state present, injection present, claims present — while never
 * deciding anything, is worse than a feature that is visibly missing. So:
 *
 * - **key has no projection ⇒ throw** (`docs_architecture.md:113`: a host reader
 *   "fails explicitly when the registry or required key is absent", registered
 *   "without silently defaulting a missing host value");
 * - **key registered, no events yet ⇒ return `initial`**, which is legitimate.
 *
 * And because `appendTaskState` reads the previous state through `taskState()` to
 * run D61's monotonicity check, the same distinction lands on the **write path**:
 * an unregistered projection must make the write fail, not be read as "there was no
 * previous state" and thereby admit any claim.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  disposeTaskStateProjection,
  registerSessionProjection,
  SessionStore,
  sessionProjectionKeys,
} from "../src/session-store.ts";
import type { SessionEvent } from "../src/session-store.ts";
import { createTestFixture } from "./fixtures.ts";

const fixture = await createTestFixture("projection-seam");
const store = new SessionStore({ root: fixture.storeRoot });

describe("session projection seam", () => {
  it("registers the core's own taskState projection", () => {
    assert.ok(
      sessionProjectionKeys().includes("taskState"),
      "the core is provider and consumer of its own projection — :113's agent loop does the same",
    );
  });

  it("returns the initial state when the key is registered but nothing was written", async () => {
    await store.create("proj-empty");
    assert.equal(await store.taskState("proj-empty"), undefined);
    assert.equal(
      await store.stateOf("proj-empty", "taskState"),
      undefined,
      "legitimate absence: no task state yet, not a wiring bug",
    );
  });

  it("throws when no projection is registered for the key", async () => {
    await store.create("proj-missing");
    await assert.rejects(
      () => store.stateOf("proj-missing", "no-such-projection"),
      /no session projection registered for key: no-such-projection/,
      "silently defaulting here is the D60 trap: everything looks wired and nothing is decided",
    );
  });

  it("keeps latest-wins, so taskState() did not change behaviour", async () => {
    const id = "proj-latest";
    await store.create(id);
    await store.appendTaskState(id, { state: "第一版", steps: [{ text: "一" }] });
    await store.appendTaskState(id, { state: "第二版", steps: [{ text: "一" }, { text: "二" }] });
    const latest = await store.taskState(id);
    assert.equal(latest?.state, "第二版");
    assert.equal(latest?.steps.length, 2);
  });

  it("makes the write path fail too once the projection is gone", async () => {
    const id = "proj-unwired";
    await store.create(id);
    await store.appendTaskState(id, { state: "开始了", steps: [{ text: "一" }] });

    disposeTaskStateProjection();
    try {
      // Read path: explicit failure rather than a silent default.
      await assert.rejects(() => store.taskState(id), /no session projection registered/);
      // ⚠️ Write path: this is D72's fourth cost. If a missing projection were read
      // as "there was no previous state", the monotonicity check would be skipped
      // and any weakened claim would be admitted.
      await assert.rejects(
        () => store.appendTaskState(id, { state: "降低标准", steps: [] }),
        /no session projection registered/,
        "an unwired projection must refuse the write, not admit any claim",
      );
    } finally {
      // Re-register so the rest of the suite sees the normal wiring.
      registerSessionProjection<import("../src/session-store.ts").TaskStateEvent | undefined>({
        key: "taskState",
        initial: undefined,
        fold: (state, event) => (event.kind === "task-state" ? event : state),
      });
    }
    assert.equal((await store.taskState(id))?.state, "开始了", "the log was never lost");
  });

  it("refuses a duplicate key and an unusable key", () => {
    assert.throws(
      () => registerSessionProjection({ key: "taskState", initial: 0, fold: (s: number) => s }),
      /already registered/,
    );
    for (const bad of ["", "   "]) {
      assert.throws(
        () => registerSessionProjection({ key: bad, initial: 0, fold: (s: number) => s }),
        /must be a non-empty string/,
      );
    }
  });

  it("folds a third-party projection over builtin events", async () => {
    // Proves the Definition is usable by someone other than the core, which is what
    // makes it a seam rather than an internal helper.
    const dispose = registerSessionProjection({
      key: "messageCount",
      initial: 0,
      fold: (count: number, event: SessionEvent) => (event.kind === "message" ? count + 1 : count),
    });
    try {
      const id = "proj-third-party";
      await store.create(id);
      assert.equal(await store.stateOf<number>(id, "messageCount"), 0);
      await store.appendMessage(id, { role: "user", content: "hi" });
      await store.appendMessage(id, { role: "assistant", content: "hello" });
      assert.equal(await store.stateOf<number>(id, "messageCount"), 2);
    } finally {
      dispose();
    }
    assert.ok(!sessionProjectionKeys().includes("messageCount"), "the disposer unwound it");
  });
});
