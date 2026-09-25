import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTestFixture } from "./fixtures.ts";
import { SessionStore } from "../src/session-store.ts";
import type { SessionEvent } from "../src/session-store.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { ToolRegistry, createReadFileTool } from "../src/tools.ts";
import type { ChatMessage } from "../src/types.ts";

/**
 * Fault injection at every durable-write boundary.
 *
 * The recovery contract claims a crash anywhere leaves a state that is either
 * readable or precisely diagnosable, and that recovery never re-executes a tool.
 * "The format looks right" is not evidence for that; failing at each write point
 * in turn is.
 *
 * Injection happens in a subclass of the store, so production code stays
 * untouched — a fault harness that needs production hooks tends to be the thing
 * that later breaks in production.
 */

type Mode = { failAt?: number; tornAt?: number };

class InjectingStore extends SessionStore {
  private writes = 0;
  private readonly mode: Mode;

  constructor(root: string, mode: Mode) {
    super({ root });
    this.mode = mode;
  }

  get writeCount(): number {
    return this.writes;
  }

  override async append(sessionId: string, event: SessionEvent): Promise<void> {
    this.writes += 1;
    if (this.mode.failAt === this.writes) {
      throw new Error(`injected failure before durable write ${this.writes}`);
    }
    if (this.mode.tornAt === this.writes) {
      // A process killed mid-write leaves a partial line, which is a different
      // failure from failing before the write: the bytes are already there.
      await appendFile(this.pathFor(sessionId), `{"v":1,"kind":"message","at":"2026-09-`, "utf8");
      throw new Error(`injected torn write at ${this.writes}`);
    }
    return super.append(sessionId, event);
  }
}

/** One send that issues exactly one tool call, so the write points are deterministic. */
const SCRIPT = [
  { content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"hello.txt"}' }] },
  { content: "done" },
];

async function scenario(label: string, mode: Mode) {
  const fixture = await createTestFixture(label);
  await writeFile(join(fixture.workspaceRoot, "hello.txt"), "file contents here", "utf8");

  const store = new InjectingStore(fixture.storeRoot, mode);
  const adapter = createScriptedAdapter({ steps: SCRIPT });
  let executed = 0;
  // A counting stand-in for the real tool: the point of this suite is that the
  // executor runs exactly once (or zero times), which needs a call counter.
  const tools = new ToolRegistry([
    {
      name: "read_file",
      description: "read",
      parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      readOnly: true,
      execute: async () => {
        executed += 1;
        return { content: "file contents here" };
      },
    },
  ]);
  const runtime = new AgentRuntime({
    adapter,
    store,
    sessionId: "crash",
    home: fixture.home,
    workspaceRoot: fixture.workspaceRoot,
    tools,
  });

  // Pre-create so the header is not one of the injected write points.
  await store.create("crash");
  const writesBefore = store.writeCount;

  let failure: unknown;
  try {
    await runtime.send("read it");
  } catch (error) {
    failure = error;
  }
  return {
    fixture,
    store,
    runtime,
    adapter,
    executed: () => executed,
    requests: () => adapter.consumed,
    failure,
    injectedWrites: store.writeCount - writesBefore,
  };
}

/** A healthy run, used as the reference for "history is an exact prefix". */
async function reference() {
  const run = await scenario("fault-reference", {});
  assert.equal(run.failure, undefined, "the reference run must succeed");
  return { history: await run.store.history("crash"), writes: run.injectedWrites };
}

describe("fault injection at every write boundary", () => {
  it("writes exactly the six points this harness assumes", async () => {
    const { history, writes } = await reference();
    assert.equal(writes, 6, "one-tool send: user, assistant, usage, tool message, assistant answer, usage");
    assert.deepEqual(
      history.map((message) => message.role),
      ["user", "assistant", "tool", "assistant"],
    );
  });

  it("leaves a readable prefix and an explicit pending state when each write fails", async () => {
    const { history: referenceHistory } = await reference();

    for (let failAt = 1; failAt <= 6; failAt += 1) {
      const run = await scenario(`fault-before-${failAt}`, { failAt });
      assert.ok(run.failure, `write ${failAt}: the send must fail rather than pretend`);

      const { problems } = await run.store.inspect("crash");
      assert.deepEqual(problems, [], `write ${failAt}: failing before a write leaves a clean log`);

      // The conversation is an exact prefix of the intact run — nothing invented,
      // nothing half-written.
      const history = await run.store.history("crash");
      assert.deepEqual(
        history,
        referenceHistory.slice(0, history.length),
        `write ${failAt}: replayed history must be a prefix of the intact run`,
      );

      const pending = await run.store.pendingTools("crash");
      const expectedPending = failAt <= 2 ? 0 : failAt <= 4 ? 1 : 0;
      assert.equal(pending.length, expectedPending, `write ${failAt}: pending state must be exact`);

      // Recovery must repair without re-running the tool.
      const executedBefore = run.executed();
      const repaired = await run.store.recover("crash");
      assert.equal(repaired, expectedPending, `write ${failAt}: recovery repairs only what is missing`);
      await run.store.assertReady("crash");
      assert.equal(run.executed(), executedBefore, `write ${failAt}: recovery must never re-execute a tool`);

      const after = await run.store.history("crash");
      const toolMessages = after.filter((message) => message.role === "tool");
      assert.equal(
        toolMessages.length,
        failAt <= 2 ? 0 : 1,
        // Writes 1-2 fail before the request itself is recorded, so there is no
        // call to answer and recovery must not invent one.
        `write ${failAt}: tool messages after repair`,
      );
      for (const message of toolMessages) {
        assert.equal(message.toolCallId, "c1", `write ${failAt}: the repair answers the recorded call`);
      }
    }
  });

  it("refuses to send again on a crashed session before calling the model", async () => {
    const run = await scenario("fault-refuse", { failAt: 3 });
    assert.ok(run.failure);
    const requestsBefore = run.requests();
    await assert.rejects(() => run.runtime.send("again"), /未完成工具结果|recover/);
    assert.equal(run.requests(), requestsBefore, "a refused send must not reach the model");
  });

  it("reports a torn line precisely and never silently repairs it", async () => {
    for (let tornAt = 1; tornAt <= 6; tornAt += 1) {
      const run = await scenario(`fault-torn-${tornAt}`, { tornAt });
      assert.ok(run.failure, `torn write ${tornAt}: the send must fail`);

      const { problems } = await run.store.inspect("crash");
      // A torn write is two findings, and both are real: the line is not JSON,
      // and the file no longer ends on a line boundary.
      assert.equal(problems.length, 2, `torn write ${tornAt}: the damage must be located, not hidden`);
      assert.match(problems.map((problem) => problem.detail).join(" | "), /invalid JSON/);
      assert.match(problems.map((problem) => problem.detail).join(" | "), /unterminated final line/);

      const bytesBefore = await readFile(run.store.pathFor("crash"), "utf8");
      // A torn log is not auto-repairable: recovery refuses and touches nothing.
      await assert.rejects(() => run.store.recover("crash"));
      assert.equal(await readFile(run.store.pathFor("crash"), "utf8"), bytesBefore, "refusal must not rewrite");

      // The same refusal must gate a send, so the model never sees a torn history.
      const requestsBefore = run.requests();
      await assert.rejects(() => run.runtime.send("again"));
      assert.equal(run.requests(), requestsBefore, `torn write ${tornAt}: no model call on a torn log`);
    }
  });

  it("recovery only ever appends, and a repaired session is usable again", async () => {
    const run = await scenario("fault-usable", { failAt: 4 });
    assert.ok(run.failure);
    const bytesBefore = await readFile(run.store.pathFor("crash"), "utf8");

    await run.store.recover("crash");
    const bytesAfter = await readFile(run.store.pathFor("crash"), "utf8");
    assert.ok(bytesAfter.startsWith(bytesBefore), "recovery appends; it never rewrites existing bytes");

    // A session repaired by recovery must be sendable again. The interrupted run
    // never wrote its final answer, so the transcript is the repaired prefix plus
    // the new turn — recovery adds what was missing, not what never happened.
    const next = createScriptedAdapter({ steps: [{ content: "second answer" }] });
    const runtime = new AgentRuntime({
      adapter: next,
      store: run.store,
      sessionId: "crash",
      home: run.fixture.home,
      workspaceRoot: run.fixture.workspaceRoot,
      tools: new ToolRegistry([createReadFileTool()]),
    });
    const result = await runtime.send("continue");
    assert.equal(result.reply.content, "second answer");
    const history: ChatMessage[] = await run.store.history("crash");
    assert.deepEqual(
      history.map((message) => message.role),
      ["user", "assistant", "tool", "user", "assistant"],
    );
  });
});