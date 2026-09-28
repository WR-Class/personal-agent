/**
 * The event-kind registry: opening `migrateEvent` without rewriting it.
 *
 * Before this, adding a session event kind meant editing the core — an 8-case
 * switch in `session-store.ts`. DSH does it the other way (`docs_architecture.md`
 * `:143`: "Add durable session state → extend `SessionEventMap`; render and
 * replay from the log", with `:113`'s *registered* projection units doing the
 * runtime half). D70 measured both halves: declaration merging covers the types,
 * a kind→handler registry covers the runtime. This is the runtime half.
 *
 * Three properties are load-bearing and each has a test, because each is the kind
 * of thing that silently rots:
 *
 * 1. **An external kind is always `ignorable: true`.** The file's own contract
 *    (`:50`, `:253-256`) is that a reader which does not recognise a kind skips
 *    it, while an *unmarked* unknown kind is an error — because silently dropping
 *    an event changes what the model is reconstructed as having seen. A kind the
 *    core does not understand must therefore be skippable by construction, or it
 *    is not an external kind but a corrupt line.
 * 2. **A builtin kind cannot be registered.** If a plugin could register
 *    `"message"`, it could reinterpret the conversation's fact source itself.
 *    This is D04 ("模型/插件不得自行扩大授权") applied to the event log.
 * 3. **The core normalises what a handler returns.** A handler cannot claim a
 *    future version, cannot rename the kind, cannot make itself non-ignorable.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  CURRENT_EVENT_VERSION,
  migrateEvent,
  registeredEventKinds,
  registerEventKind,
} from "../src/session-store.ts";

/** Every kind the core itself parses. Registration must refuse all of them. */
const BUILTIN_KINDS = [
  "session",
  "message",
  "usage",
  "tool/call",
  "tool/result",
  "summary",
  "task-state",
  "audit",
] as const;

/** A minimal handler: keep an opaque payload, nothing else. */
const keepPayload = (record: Record<string, unknown>) => ({
  v: 0,
  kind: "",
  ignorable: true as const,
  at: typeof record.at === "string" ? record.at : "",
  payload: record.payload,
});

describe("event kind registry", () => {
  it("lets a registered kind round-trip through migrateEvent", () => {
    const dispose = registerEventKind("probe/echo", keepPayload);
    try {
      const at = "2026-09-30T00:00:00.000Z";
      const event = migrateEvent({ kind: "probe/echo", at, payload: { n: 7 } });
      assert.ok(event, "a registered kind must parse");
      assert.ok("payload" in event, "an external event carries an opaque payload");
      assert.equal(event.kind, "probe/echo");
      assert.equal(event.v, CURRENT_EVENT_VERSION);
      assert.equal(event.ignorable, true);
      assert.deepEqual(event.payload, { n: 7 }, "the payload survives untouched — the core never interprets it");
    } finally {
      dispose();
    }
  });

  it("makes the kind unknown again once disposed", () => {
    const dispose = registerEventKind("probe/temporary", keepPayload);
    assert.ok(registeredEventKinds().includes("probe/temporary"));
    dispose();
    assert.ok(!registeredEventKinds().includes("probe/temporary"));
    // Unknown but marked ignorable: skipped, exactly as an older reader would.
    assert.equal(
      migrateEvent({ kind: "probe/temporary", ignorable: true, at: "2026-09-30T00:00:00.000Z" }),
      null,
    );
    // Unknown and unmarked: still an error, so nothing is silently dropped.
    assert.throws(
      () => migrateEvent({ kind: "probe/temporary", at: "2026-09-30T00:00:00.000Z" }),
      /unknown event kind/,
    );
    // Disposing twice must not throw, and must not unregister a re-registration.
    const again = registerEventKind("probe/temporary", keepPayload);
    dispose();
    assert.ok(
      registeredEventKinds().includes("probe/temporary"),
      "a stale disposer must not unregister someone else's registration",
    );
    again();
  });

  it("refuses a duplicate registration", () => {
    const dispose = registerEventKind("probe/dup", keepPayload);
    try {
      assert.throws(
        () => registerEventKind("probe/dup", keepPayload),
        /already registered/,
        "two answers for one kind is the failure mode this registry exists to avoid",
      );
    } finally {
      dispose();
    }
  });

  it("refuses every builtin kind", () => {
    for (const kind of BUILTIN_KINDS) {
      assert.throws(
        () => registerEventKind(kind, keepPayload),
        /builtin/,
        `registering "${kind}" would let a caller reinterpret the core's own fact source`,
      );
    }
    assert.deepEqual(
      registeredEventKinds().filter((k) => (BUILTIN_KINDS as readonly string[]).includes(k)),
      [],
      "no builtin kind is ever listed as external",
    );
  });

  it("refuses a kind that is not a usable name", () => {
    for (const bad of ["", "   "]) {
      assert.throws(() => registerEventKind(bad, keepPayload), /kind must be/);
    }
  });

  it("normalises what a handler returns", () => {
    // A handler that tries to claim a non-ignorable, future-versioned, renamed event.
    const dispose = registerEventKind("probe/lying", () => ({
      v: CURRENT_EVENT_VERSION + 5,
      kind: "message",
      ignorable: false,
      at: "2026-09-30T00:00:00.000Z",
      payload: "x",
    }) as never);
    try {
      const event = migrateEvent({ kind: "probe/lying", at: "2026-09-30T00:00:00.000Z" });
      assert.ok(event);
      assert.ok("payload" in event, "still an external event, whatever the handler claimed");
      assert.equal(event.ignorable, true, "ignorable is forced true — a kind the core cannot interpret must be skippable");
      assert.equal(event.kind, "probe/lying", "the kind comes from the record, not from the handler");
      assert.equal(event.v, CURRENT_EVENT_VERSION, "a handler cannot claim a version this reader does not support");
    } finally {
      dispose();
    }
  });

  it("refuses a handler that returns nothing usable", () => {
    const dispose = registerEventKind("probe/void", (() => undefined) as never);
    try {
      assert.throws(() => migrateEvent({ kind: "probe/void", at: "2026-09-30T00:00:00.000Z" }), /handler/);
    } finally {
      dispose();
    }
  });

  it("leaves the version gate ahead of the registry", () => {
    const dispose = registerEventKind("probe/gated", keepPayload);
    try {
      // A future version is refused before any handler is consulted: the reader
      // cannot know what a newer writer meant, so it must not pretend to.
      assert.throws(
        () =>
          migrateEvent({
            v: CURRENT_EVENT_VERSION + 1,
            kind: "probe/gated",
            at: "2026-09-30T00:00:00.000Z",
          }),
        /newer than supported/,
      );
    } finally {
      dispose();
    }
  });

  it("still parses every builtin kind exactly as before", () => {
    // Regression guard: the switch was left alone, so these must not move.
    const at = "2026-09-30T00:00:00.000Z";
    assert.equal(migrateEvent({ kind: "session", id: "s1", createdAt: at })?.kind, "session");
    assert.equal(
      migrateEvent({ kind: "message", at, message: { role: "user", content: "hi" } })?.kind,
      "message",
    );
    assert.equal(
      migrateEvent({ kind: "audit", at, tool: "read_file", decision: "denied", reason: "r" })?.kind,
      "audit",
    );
    assert.equal(migrateEvent({ kind: "no-such-kind", ignorable: true, at }), null);
    assert.throws(() => migrateEvent({ kind: "no-such-kind", at }), /unknown event kind/);
  });
});
