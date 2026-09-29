/**
 * The two halves of the seam must actually connect.
 *
 * D71 added `registerEventKind`: a kind registered from outside parses through the
 * registry and lands in `InspectionResult.external`, not in `events`. D73 added the
 * projection seam: `stateOf` folds events into one typed state. Shipped separately,
 * they did not meet — `stateOf` folded `report.events` only, so a plugin that
 * registered BOTH a kind and a projection got a projection that never saw a single
 * event of its own kind.
 *
 * ⚠️ That is the D60 shape, and D73's own third-party-projection test could not
 * catch it because it folded `message`, a builtin kind living in `events`. This file
 * folds an external kind, which is the case that was broken.
 *
 * Also pinned: the fold must run in **line order** across both collections.
 * "All of events, then all of external" would silently break latest-wins, because an
 * external kind's lines are interleaved with builtin ones in the same log.
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
import type { ExternalSessionEvent, SessionEvent } from "../src/session-store.ts";
import { createTestFixture } from "./fixtures.ts";

const fixture = await createTestFixture("projection-external");
const store = new SessionStore({ root: fixture.storeRoot });

const KIND = "probe/marker";

/** Append one raw line of the external kind straight to the log. */
async function appendMarker(id: string, n: number): Promise<void> {
  const line = JSON.stringify({
    v: CURRENT_EVENT_VERSION,
    kind: KIND,
    ignorable: true,
    at: new Date().toISOString(),
    payload: n,
  });
  await appendFile(store.pathFor(id), `${line}\n`, "utf8");
}

describe("a projection over an externally registered kind", () => {
  it("sees the events of the kind it was registered for", async () => {
    const disposeKind = registerEventKind(KIND, (record) => ({
      v: 0,
      kind: "",
      ignorable: true,
      at: typeof record.at === "string" ? record.at : "",
      payload: record.payload,
    }));
    const disposeProjection = registerSessionProjection({
      key: "markerSum",
      initial: 0,
      fold: (sum: number, event: SessionEvent | ExternalSessionEvent) =>
        event.kind === KIND && "payload" in event && typeof event.payload === "number"
          ? sum + event.payload
          : sum,
    });
    try {
      const id = "ext-projection";
      await store.create(id);
      assert.equal(await store.stateOf<number>(id, "markerSum"), 0);

      await appendMarker(id, 2);
      await appendMarker(id, 5);
      assert.equal(
        await store.stateOf<number>(id, "markerSum"),
        7,
        "an external kind's events must reach its own projection — this was the shipped defect",
      );
    } finally {
      disposeProjection();
      disposeKind();
    }
  });

  it("folds in line order, not events-then-external", async () => {
    // ⚠️ A latest-wins assertion does NOT discriminate here, and the first version of
    // this test used one: `external` is already in line order, so draining `events`
    // first and `external` second still ends on the last marker. Mutation A ("all of
    // events, then all of external") stayed green. The property only shows up in a
    // fold whose result depends on the interleaving itself, so this records the
    // sequence and asserts the interleaving, which the mutation cannot survive.
    const disposeKind = registerEventKind(KIND, (record) => ({
      v: 0,
      kind: "",
      ignorable: true,
      at: typeof record.at === "string" ? record.at : "",
      payload: record.payload,
    }));
    const disposeProjection = registerSessionProjection({
      key: "trace",
      initial: "",
      fold: (trace: string, event: SessionEvent | ExternalSessionEvent) =>
        event.kind === KIND
          ? `${trace}m`
          : event.kind === "message"
            ? `${trace}x`
            : trace,
    });
    try {
      const id = "ext-order";
      await store.create(id);
      await appendMarker(id, 1);
      await store.appendMessage(id, { role: "user", content: "in between" });
      await appendMarker(id, 9);
      await store.appendMessage(id, { role: "assistant", content: "after" });
      assert.equal(
        await store.stateOf<string>(id, "trace"),
        "mxmx",
        "markers and messages must fold in log order; 'xxmm' means the collections were drained separately",
      );
    } finally {
      disposeProjection();
      disposeKind();
    }
  });

  it("still refuses a malformed line of an external kind by line number", async () => {
    // D72's hard constraint: moving validation out of the core switch must not turn
    // a diagnosable failure into an undiagnosable one.
    const disposeKind = registerEventKind(KIND, (record) => {
      if (typeof record.payload !== "number") throw new Error("marker payload must be a number");
      return {
        v: 0,
        kind: "",
        ignorable: true,
        at: typeof record.at === "string" ? record.at : "",
        payload: record.payload,
      };
    });
    try {
      const id = "ext-malformed";
      await store.create(id);
      await appendMarker(id, 3);
      await appendFile(
        store.pathFor(id),
        `${JSON.stringify({ v: CURRENT_EVENT_VERSION, kind: KIND, ignorable: true, at: "x", payload: "not a number" })}\n`,
        "utf8",
      );
      const report = await store.inspect(id);
      assert.equal(report.problems.length, 1, "the bad line is reported, not skipped");
      const problem = report.problems[0];
      assert.ok(problem);
      assert.equal(problem.detail, "marker payload must be a number");
      assert.ok(problem.line > 0, "and it says which line");
      assert.equal(report.external.length, 1, "the good line still parsed");
    } finally {
      disposeKind();
    }
  });
});
