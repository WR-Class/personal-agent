/**
 * The loop noticing that it is going nowhere (D161).
 *
 * The protection this project had before this file was **exhaustion**: steps run
 * out, tool calls run out, the wall clock runs out. Nothing ever *noticed* a round
 * that was repeating itself — a real run was measured at five steps, 542 seconds
 * and a provider error while it kept re-reading one file by different means.
 *
 * ⚠️ The signal is deliberately the narrowest one available, and the narrowness is
 * the design rather than timidity. Every cheaper heuristic has a legitimate twin:
 *
 * - "the same tool twice" is polling a job whose output has not changed yet;
 * - "no writes for N steps" is an audit that only ever reads;
 * - "no new tool name" is a deep look at a single file.
 *
 * A call that returns **byte-identical content** to an earlier call in the same
 * round has no such twin: the model asked again and was handed exactly what it
 * already had. So that is the whole test, and it is a notice rather than a stop —
 * stopping would abort the legitimate polling case, which is indistinguishable
 * from this one at this distance.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AgentRuntime } from "../src/runtime.ts";
import { SessionStore } from "../src/session-store.ts";
import { ToolRegistry, createReadFileTool } from "../src/tools.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { createTestFixture } from "./fixtures.ts";
import type { ToolCall } from "../src/types.ts";

const fixture = await createTestFixture("loop-progress");
const home = fixture.storeRoot;
const workspaceRoot = fixture.workspaceRoot;

await writeFile(join(workspaceRoot, "a.txt"), "the same answer every time\n", "utf8");
await writeFile(join(workspaceRoot, "b.txt"), "a different answer\n", "utf8");

let created = 0;

/** One `read_file` call, as the model would emit it. */
const read = (path: string, id: string): ToolCall => ({
  id,
  name: "read_file",
  arguments: JSON.stringify({ path }),
});

async function round(steps: unknown[]) {
  const sessionId = `loop-${created++}`;
  const store = new SessionStore({ root: home });
  await store.create(sessionId);
  const adapter = createScriptedAdapter({ steps: steps as never, model: "loop-model" });
  const agent = new AgentRuntime({
    adapter,
    store,
    sessionId,
    home,
    workspaceRoot,
    tools: new ToolRegistry([createReadFileTool()], ["read_file"]),
    systemPrompt: "You are a concise assistant.",
    approve: async () => true,
  });
  return { result: await agent.send("开始"), adapter, store, sessionId };
}

/** The evidence line the evaluation carries, or undefined when it carries none. */
const stuckEvidence = (evidence: readonly string[]): string | undefined =>
  evidence.find((line) => line.startsWith("stuckRepeats="));

describe("a round that keeps asking and keeps being told the same thing", () => {
  it("⚠️ notices it once, and records the repeat", async () => {
    const { result, adapter } = await round([
      { toolCalls: [read("a.txt", "c1")] },
      { toolCalls: [read("a.txt", "c2")] },
      { content: "读完了" },
    ]);

    // Three requests: the two reads, then the summary. The notice rides on the
    // third, because it is built at the top of the step after the repeat.
    assert.equal(adapter.requests.length, 3);
    const notice = adapter.requests[2]!.messages.at(-1)!.content;
    assert.match(notice, /returned exactly what an earlier call in the same round returned/);
    // And it says what to do instead. A notice that only reports the repeat leaves
    // the model with nothing to act on.
    assert.match(notice, /Do something different/);

    assert.equal(stuckEvidence(result.evaluation.evidence), "stuckRepeats=1");
    // ⚠️ And it is evidence, not a verdict: the round still succeeded, because a
    // repeat is a smell and this project separates what was observed from what was
    // concluded. If this ever reads `partial`, the count has been wired into the
    // status and the one legitimate repeat (polling) has been made a failure.
    assert.equal(result.evaluation.status, "success");
  });

  it("says nothing when the second call comes back different", async () => {
    const { result, adapter } = await round([
      { toolCalls: [read("a.txt", "c1")] },
      { toolCalls: [read("b.txt", "c2")] },
      { content: "都读完了" },
    ]);
    assert.equal(adapter.requests.length, 3);
    assert.ok(
      !adapter.requests[2]!.messages.at(-1)!.content.includes("exactly what an earlier call"),
      "two different reads are not a repeat",
    );
    assert.equal(stuckEvidence(result.evaluation.evidence), undefined, "and nothing is recorded");
  });

  it("counts every repeat but says it only once", async () => {
    const { result, adapter } = await round([
      { toolCalls: [read("a.txt", "c1")] },
      { toolCalls: [read("a.txt", "c2")] },
      { toolCalls: [read("a.txt", "c3")] },
      { content: "读完了" },
    ]);
    // Four requests: three reads and the summary. The notice appears on the third
    // and is still there on the fourth — it is carried, not re-issued.
    assert.equal(adapter.requests.length, 4);
    assert.match(adapter.requests[2]!.messages.at(-1)!.content, /returned exactly what an earlier call/);
    assert.equal(stuckEvidence(result.evaluation.evidence), "stuckRepeats=2", "both repeats are counted");
  });

  it("does not carry one round's answers into the next", async () => {
    // The map is per round. Without clearing it, round two's first read of a file
    // round one already read would be reported as a repeat the model never made.
    const sessionId = "loop-carryover";
    const store = new SessionStore({ root: home });
    await store.create(sessionId);
    const adapter = createScriptedAdapter({
      steps: [
        { toolCalls: [read("a.txt", "c1")] },
        { content: "第一轮" },
        { toolCalls: [read("a.txt", "c2")] },
        { content: "第二轮" },
      ] as never,
      model: "loop-model",
    });
    const agent = new AgentRuntime({
      adapter, store, sessionId, home, workspaceRoot,
      tools: new ToolRegistry([createReadFileTool()], ["read_file"]),
      systemPrompt: "You are a concise assistant.",
      approve: async () => true,
    });

    await agent.send("开始");
    const second = await agent.send("继续");
    assert.equal(
      stuckEvidence(second.evaluation.evidence),
      undefined,
      "the same read in a later round is a new question, not a repeated one",
    );
  });
});
