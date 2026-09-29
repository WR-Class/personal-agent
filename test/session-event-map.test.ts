/**
 * Route 丙 (D75/D76) measured in the real file rather than in a probe directory.
 *
 * The augmentation below is deliberate and it is the point of this file. Because
 * `tsconfig.json` includes the whole `test` tree, this `declare module` is visible
 * while `src/` is being compiled — which is `docs_development.md:56`'s "one program
 * seeing both merges", happening inside our single program. So this file measures
 * two things at once:
 *
 * 1. does a merged kind join `SessionEvent` **with its own literal**, so that
 *    narrowing on it yields a typed payload (the property route 丙 rests on);
 * 2. does that merge **pollute the core** — i.e. do the eight narrowing sites in
 *    `session-store.ts` still type-check while this augmentation is in the program.
 *
 * ⚠️ Property 2 is not asserted here, it is asserted by `tsc --noEmit` over the
 * whole project passing while this file exists. A test cannot prove its own absence
 * of pollution; the compiler checking `src/` under this augmentation can.
 */

import assert from "node:assert/strict";
import { appendFile } from "node:fs/promises";
import { describe, it } from "node:test";

import {
  CURRENT_EVENT_VERSION,
  registerEventKind,
  registerSessionProjection,
  SessionStore,
} from "../src/session-store.ts";
import type { ExternalSessionEvent, SessionEvent, SessionEventMap } from "../src/session-store.ts";
import { createTestFixture } from "./fixtures.ts";

const KIND = "probe/augmented";

/**
 * ⚠️ The augmentation under test. Note that it contributes a **distinct literal**
 * `kind`, which is exactly what `ExternalSessionEvent`'s `kind: string` could not
 * do and why D71 measured eight broken narrowing sites.
 */
declare module "../src/session-store.ts" {
  interface SessionEventMap {
    "probe/augmented": {
      readonly v: number;
      readonly kind: "probe/augmented";
      readonly ignorable: true;
      readonly at: string;
      readonly n: number;
    };
  }
}

const fixture = await createTestFixture("session-event-map");
const store = new SessionStore({ root: fixture.storeRoot });

describe("SessionEventMap is merge-extensible", () => {
  it("a merged kind joins the union with its own literal and a typed payload", () => {
    // ⚠️ If the augmentation had not reached the derived union, `Augmented` would be
    // `never` and the assignment below would be a compile error. That is the
    // discriminator: this test cannot pass by accident at runtime, because the
    // property it pins is checked before the test ever runs.
    type Augmented = Extract<SessionEvent, { kind: "probe/augmented" }>;
    const event: Augmented = {
      v: CURRENT_EVENT_VERSION,
      kind: "probe/augmented",
      ignorable: true,
      at: "2026-09-30T00:00:00.000Z",
      n: 7,
    };
    assert.equal(event.n, 7, "the payload field is typed, not `unknown`");

    // And narrowing on the literal inside a function that receives the whole union
    // works the same way — this is the shape the eight core sites use.
    const read = (e: SessionEvent): number => (e.kind === KIND ? e.n : -1);
    assert.equal(read(event), 7);
  });

  it("keeps every builtin kind distinguishable alongside the merged one", () => {
    // ⚠️ If the merged member had widened the union (the D71 catch-all failure), this
    // array would still compile because `SessionEvent["kind"]` would be `string`.
    // Conversely if the merge had not landed, "probe/augmented" would error. So this
    // pins both directions at once.
    const kinds: readonly SessionEvent["kind"][] = [
      "session",
      "message",
      "usage",
      "tool/call",
      "tool/result",
      "summary",
      "task-state",
      "audit",
      "probe/augmented",
    ];
    assert.equal(kinds.length, 9);
    // The table itself is addressable by kind, which is what makes it a table rather
    // than a list: a plugin's shape is reachable as SessionEventMap["its/kind"].
    type Merged = SessionEventMap["probe/augmented"];
    const shape: Merged["n"] = 1;
    assert.equal(shape, 1);
  });

  it("connects to the runtime registry, so the type side and the log side meet", async () => {
    // Route 丙 is only worth anything if a kind that is merged at the type level can
    // also be registered at runtime, parsed out of the log, and folded by a
    // projection. That is D71's registry plus D74's line-order merge plus this
    // round's table, in one path.
    const disposeKind = registerEventKind(KIND, (record) => ({
      v: CURRENT_EVENT_VERSION,
      kind: "",
      ignorable: true,
      at: typeof record.at === "string" ? record.at : "",
      payload: record.n,
    }));
    const disposeProjection = registerSessionProjection({
      key: "augmentedSum",
      initial: 0,
      fold: (sum: number, event: SessionEvent | ExternalSessionEvent) =>
        event.kind === KIND && "payload" in event && typeof event.payload === "number"
          ? sum + event.payload
          : sum,
    });
    try {
      const id = "augmented";
      await store.create(id);
      await store.appendMessage(id, { role: "user", content: "before" });
      for (const n of [3, 4]) {
        await appendFile(
          store.pathFor(id),
          `${JSON.stringify({ v: CURRENT_EVENT_VERSION, kind: KIND, ignorable: true, at: "x", n })}\n`,
          "utf8",
        );
      }
      const report = await store.inspect(id);
      assert.equal(report.external.length, 2, "both lines parsed through the registry");
      assert.equal(report.problems.length, 0);
      assert.equal(
        await store.stateOf<number>(id, "augmentedSum"),
        7,
        "and the projection folded them, interleaved with builtin lines",
      );
    } finally {
      disposeProjection();
      disposeKind();
    }
  });
});
