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

/**
 * ⚠️ Wiring (D81): the seam has to be tested from both sides. `taskspec-prompt
 * .test.ts` proves the assembly; these prove it actually reaches the model and
 * that it is charged to the injected-bytes cap. D74 shipped a seam whose two
 * halves never connected — both registries listed the plugin, every test passed,
 * and the projection never saw its own events. Testing only the pure function
 * reproduces exactly that shape.
 */
describe("TaskSpec reaches the prompt (D81)", () => {
  const make = async (id: string, overrides: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {}) => {
    const fixture = await createTestFixture("taskspec-wiring");
    return new AgentRuntime({
      adapter: createEchoAdapter(),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: id,
      home: fixture.home,
      workspaceRoot: fixture.workspaceRoot,
      systemPrompt: "SYSTEM-MARKER",
      ...overrides,
    });
  };

  it("the intent fragment is in the system text the model receives", async () => {
    const agent = await make("wire-intent");
    const sent = await agent.send("验证这个改动");
    const system = sent.history[0];
    assert.equal(system?.role, "system");
    const text = String(system?.content ?? "");
    assert.ok(text.includes("SYSTEM-MARKER"), "产品自身的系统文本仍在");
    assert.ok(text.includes("本轮意图：verify"), "意图分类的结果此前被丢掉，现在必须进提示词");
    // Authority order: the request-derived block rides last, below the product's
    // own text. If this assertion ever goes green after a reorder, no test is
    // pinning the order — fix the test, do not accept the reorder.
    assert.ok(text.indexOf("SYSTEM-MARKER") < text.indexOf("本轮意图：verify"), "请求派生块必须排在产品文本之后");
  });

  it("a matched skill's prompt is injected, and an unmatched one is not", async () => {
    const skills = [{ id: "video-fetch", scenarios: ["视频下载"], prompt: "SKILL-MARKER-VIDEO" }];
    const hit = await make("wire-hit", { taskPromptSkills: skills });
    assert.ok(String((await hit.send("帮我做视频下载")).history[0]?.content ?? "").includes("SKILL-MARKER-VIDEO"));
    const miss = await make("wire-miss", { taskPromptSkills: skills });
    const text = String((await miss.send("重构这个函数")).history[0]?.content ?? "");
    assert.ok(!text.includes("SKILL-MARKER-VIDEO"), "没有就不匹配：未命中的 skill 一个字都不得进提示词");
    assert.ok(text.includes("本轮意图：build"), "但意图片段仍在");
  });

  it("⚠️ the block is charged to the injected-bytes cap, so it cannot bypass it", async () => {
    // Cap is maxContextBytes / 4 = 1000. The skill prompt alone exceeds it while
    // the whole prompt still fits the 4000-byte window, so the only thing that can
    // refuse this turn is the injected-bytes check. Removing the block from
    // `injectedBytes` turns this rejection into a success — that is mutation B.
    const big = "X".repeat(1500);
    const agent = await make("wire-cap", {
      maxContextBytes: 4000,
      taskPromptSkills: [{ id: "big", scenarios: ["触发"], prompt: big }],
    });
    await assert.rejects(() => agent.send("触发这个"), /注入块合计/);
    const message = await agent
      .send("触发这个")
      .then(() => "")
      .catch((error: unknown) => String((error as Error).message));
    assert.ok(/本轮提示 \d{3,}/.test(message), `报错必须把新块列进枚举，否则会少报一块；实际报错：${message}`);
  });
});
