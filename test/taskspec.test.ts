import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { TASKSPEC_VERSION, TASK_MODE, buildTaskSpec, assessTaskSpec } from "../src/taskspec.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { SessionStore } from "../src/session-store.ts";
import { createEchoAdapter } from "../src/echo-adapter.ts";
import { createTestFixture } from "./fixtures.ts";

describe("TaskSpec", () => {
  it("is deterministic, versioned, and mode-authoritative", () => {
    const first = buildTaskSpec("修复这个 bug，并验证结果", { mode: TASK_MODE });
    const second = buildTaskSpec("修复这个 bug，并验证结果", { mode: TASK_MODE });
    assert.equal(first.schema, TASKSPEC_VERSION);
    assert.equal(first.intent, "fix");
    assert.equal(first.selectedMode, "single-agent");
    assert.equal(first.evidence.authoritativeMode, true);
    assert.deepEqual(first.unknowns, []);
    assert.equal(JSON.stringify(first), JSON.stringify(second));
  });

  it("fails open on a missing objective and never invents a mode", () => {
    const spec = buildTaskSpec("", {});
    assert.ok(spec.unknowns.includes("objective"));
    assert.ok(spec.unknowns.includes("mode"));
    assert.equal(spec.selectedMode, undefined);
    assert.equal(spec.evidence.authoritativeMode, false);
  });

  it("keeps the first text part of structured input and classifies deterministically", () => {
    const spec = buildTaskSpec({ content: [{ type: "text", text: "research this" }, { type: "image", url: "x" }] }, { mode: TASK_MODE });
    assert.equal(spec.originalInput, "research this");
    assert.equal(spec.intent, "research");
  });

  it("defaults to the build intent when no keyword matches", () => {
    assert.equal(buildTaskSpec("随便聊聊", { mode: TASK_MODE }).intent, "build");
    assert.equal(buildTaskSpec("verify this", { mode: TASK_MODE }).intent, "verify");
    assert.equal(buildTaskSpec("部署上线", { mode: TASK_MODE }).intent, "operate");
  });

  it("enforcement is a separate, default-off switch", () => {
    const incomplete = buildTaskSpec("");
    assert.equal(assessTaskSpec(incomplete).blocked, false);
    assert.equal(assessTaskSpec(incomplete, { enforce: true }).blocked, true);
    const complete = buildTaskSpec("verify this", { mode: TASK_MODE });
    assert.equal(assessTaskSpec(complete, { enforce: true }).blocked, false);
  });
});

describe("runtime records a TaskSpec before the model call", () => {
  it("returns the spec of this send, with the mode owned by the runtime", async () => {
    const fixture = await createTestFixture("taskspec");
    const runtime = new AgentRuntime({
      adapter: createEchoAdapter(),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: "spec1",
      home: fixture.home,
      workspaceRoot: fixture.workspaceRoot,
    });
    const result = await runtime.send("验证这个改动");
    assert.equal(result.taskSpec.originalInput, "验证这个改动");
    assert.equal(result.taskSpec.intent, "verify");
    assert.equal(result.taskSpec.selectedMode, "single-agent");
    assert.equal(result.taskSpec.evidence.authoritativeMode, true);
    const again = await runtime.send("验证这个改动");
    assert.equal(JSON.stringify(again.taskSpec), JSON.stringify(result.taskSpec));
  });

  it("enforcement on does not disturb a complete spec", async () => {
    const fixture = await createTestFixture("taskspec");
    const runtime = new AgentRuntime({
      adapter: createEchoAdapter(),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: "spec2",
      home: fixture.home,
      workspaceRoot: fixture.workspaceRoot,
      enforceTaskSpec: true,
    });
    const result = await runtime.send("normal work");
    assert.equal(result.taskSpec.intent, "build");
  });
});
