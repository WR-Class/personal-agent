import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { createTestFixture } from "./fixtures.ts";
import { SessionStore, migrateEvent } from "../src/session-store.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { ToolRegistry, createReadFileTool } from "../src/tools.ts";
import type { ChatMessage } from "../src/types.ts";

/**
 * Old-format golden fixtures.
 *
 * PR3 item 5 and ADR-0001 both require these *before* the on-disk shape changes:
 * once `tool/call` and `tool/result` stop being written, the only way to know the
 * change was safe is a byte-frozen log from the current format plus an assertion
 * that reading it still yields the same conversation.
 *
 * These strings are deliberately literal. If a future edit changes what v1 lines
 * look like, that edit has to change this file too — which is the point.
 */

/** A v1 log exactly as `runtime.ts` writes one today: header, user, assistant+call, audit pair, tool message, final answer. */
const V1_COMPLETE = [
  `{"v":1,"kind":"session","id":"golden","createdAt":"2026-09-24T00:00:00.000Z"}`,
  `{"v":1,"kind":"message","at":"2026-09-24T00:00:01.000Z","message":{"role":"user","content":"read hello"}}`,
  `{"v":1,"kind":"message","at":"2026-09-24T00:00:02.000Z","message":{"role":"assistant","content":"","toolCalls":[{"id":"c1","name":"read_file","arguments":"{\\"path\\":\\"hello.txt\\"}"}]},"model":"golden-1"}`,
  `{"v":1,"kind":"usage","at":"2026-09-24T00:00:03.000Z","usage":{"inputTokens":10,"outputTokens":5}}`,
  `{"v":1,"kind":"tool/call","ignorable":true,"at":"2026-09-24T00:00:04.000Z","callId":"c1","name":"read_file","arguments":"{\\"path\\":\\"hello.txt\\"}"}`,
  `{"v":1,"kind":"tool/result","ignorable":true,"at":"2026-09-24T00:00:05.000Z","callId":"c1","name":"read_file","content":"file contents here","isError":false}`,
  `{"v":1,"kind":"message","at":"2026-09-24T00:00:06.000Z","message":{"role":"tool","content":"file contents here","toolCallId":"c1"}}`,
  `{"v":1,"kind":"message","at":"2026-09-24T00:00:07.000Z","message":{"role":"assistant","content":"it says: file contents here"},"model":"golden-1"}`,
  `{"v":1,"kind":"usage","at":"2026-09-24T00:00:08.000Z","usage":{"inputTokens":20,"outputTokens":9}}`,
].join("\n") + "\n";

/** The same call, interrupted after the result was written but before its message. */
const V1_HALF_BATCH = [
  `{"v":1,"kind":"session","id":"half","createdAt":"2026-09-24T00:00:00.000Z"}`,
  `{"v":1,"kind":"message","at":"2026-09-24T00:00:01.000Z","message":{"role":"user","content":"read hello"}}`,
  `{"v":1,"kind":"message","at":"2026-09-24T00:00:02.000Z","message":{"role":"assistant","content":"","toolCalls":[{"id":"c9","name":"read_file","arguments":"{\\"path\\":\\"hello.txt\\"}"}]}}`,
  `{"v":1,"kind":"tool/call","ignorable":true,"at":"2026-09-24T00:00:03.000Z","callId":"c9","name":"read_file","arguments":"{\\"path\\":\\"hello.txt\\"}"}`,
  `{"v":1,"kind":"tool/result","ignorable":true,"at":"2026-09-24T00:00:04.000Z","callId":"c9","name":"read_file","content":"file contents here","isError":false}`,
].join("\n") + "\n";

/** Interrupted mid-execution: the call was recorded, nothing came back. */
const V1_NO_RESULT = [
  `{"v":1,"kind":"session","id":"unknown","createdAt":"2026-09-24T00:00:00.000Z"}`,
  `{"v":1,"kind":"message","at":"2026-09-24T00:00:01.000Z","message":{"role":"user","content":"read hello"}}`,
  `{"v":1,"kind":"message","at":"2026-09-24T00:00:02.000Z","message":{"role":"assistant","content":"","toolCalls":[{"id":"c7","name":"read_file","arguments":"{\\"path\\":\\"hello.txt\\"}"}]}}`,
  `{"v":1,"kind":"tool/call","ignorable":true,"at":"2026-09-24T00:00:03.000Z","callId":"c7","name":"read_file","arguments":"{\\"path\\":\\"hello.txt\\"}"}`,
].join("\n") + "\n";

async function seeded(label: string, sessionId: string, contents: string) {
  const fixture = await createTestFixture(label);
  const store = new SessionStore({ root: fixture.storeRoot });
  await writeFile(store.pathFor(sessionId), contents, { encoding: "utf8", flag: "wx" });
  return { fixture, store, path: store.pathFor(sessionId) };
}

describe("v1 golden fixtures", () => {
  it("reads a complete v1 batch with no problems and replays the same conversation", async () => {
    const { store } = await seeded("golden-complete", "golden", V1_COMPLETE);

    const { events, problems } = await store.inspect("golden");
    assert.deepEqual(problems, []);

    const expected: ChatMessage[] = [
      { role: "user", content: "read hello" },
      {
        role: "assistant",
        content: "",
        toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"hello.txt"}' }],
      },
      { role: "tool", content: "file contents here", toolCallId: "c1" },
      { role: "assistant", content: "it says: file contents here" },
    ];
    assert.deepEqual(await store.history("golden"), expected);

    // Only the fields the runtime actually persists survive a read — no extras.
    for (const event of events) {
      if (event.kind !== "message") continue;
      assert.deepEqual(
        Object.keys(event.message).sort(),
        event.message.role === "tool"
          ? ["content", "role", "toolCallId"]
          : event.message.toolCalls
            ? ["content", "role", "toolCalls"]
            : ["content", "role"],
      );
    }
  });

  it("keeps usages and a complete batch recognisable as nothing to recover", async () => {
    const { store } = await seeded("golden-totals", "golden", V1_COMPLETE);
    assert.deepEqual(await store.totals("golden"), { inputTokens: 30, outputTokens: 14 });
    assert.deepEqual(await store.pendingTools("golden"), []);
    await store.assertReady("golden");
  });

  it("treats a half-written batch as recoverable and repairs it without rerunning the tool", async () => {
    const { store, path } = await seeded("golden-half", "half", V1_HALF_BATCH);

    const pending = await store.pendingTools("half");
    assert.equal(pending.length, 1);
    assert.equal(pending[0]!.call.id, "c9");
    assert.equal(pending[0]!.result?.content, "file contents here");
    await assert.rejects(() => store.assertReady("half"), /未完成工具结果/);

    const before = await readFile(path, "utf8");
    assert.equal(await store.recover("half"), 1);

    // Recovery appends; it must not rewrite or re-execute anything already there.
    const after = await readFile(path, "utf8");
    assert.ok(after.startsWith(before), "recovery must append, never rewrite the original bytes");

    const history = await store.history("half");
    const toolMessage = history.at(-1)!;
    assert.equal(toolMessage.role, "tool");
    assert.equal(toolMessage.toolCallId, "c9");
    assert.equal(toolMessage.content, "file contents here", "an existing result must be reused, not fabricated");
    assert.deepEqual(await store.pendingTools("half"), []);
    assert.equal(await store.recover("half"), 0, "recovery is idempotent");
  });

  it("marks an interrupted call as unknown instead of inventing an outcome", async () => {
    const { store, path } = await seeded("golden-unknown", "unknown", V1_NO_RESULT);

    assert.equal(await store.recover("unknown"), 1);
    const history = await store.history("unknown");
    const toolMessage = history.at(-1)!;
    assert.match(toolMessage.content, /outcome unknown/);
    assert.match(toolMessage.content, /NOT replayed/);

    // Since ADR-0001 the repair is a single message line — no audit pair.
    const appended = (await readFile(path, "utf8")).slice(V1_NO_RESULT.length).trim().split("\n");
    assert.equal(appended.length, 1);
    const repair = JSON.parse(appended[0]!) as { kind: string; isError?: boolean; message: unknown };
    assert.equal(repair.kind, "message");
    assert.equal(repair.isError, true, "an unknown outcome is an error, not a silent success");
  });

  it("writes one line per tool call instead of an audit pair plus a message", async () => {
    // The ADR-0001 shape, frozen from a real runtime run rather than hand-built:
    // the assistant turn records the request, the tool message records the result.
    const fixture = await createTestFixture("golden-written");
    const store = new SessionStore({ root: fixture.storeRoot });
    await writeFile(
      join(fixture.workspaceRoot, "hello.txt"),
      "file contents here",
      "utf8",
    );
    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({
        steps: [
          { content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"hello.txt"}' }] },
          { content: "done" },
        ],
      }),
      store,
      sessionId: "written",
      home: fixture.home,
      workspaceRoot: fixture.workspaceRoot,
      tools: new ToolRegistry([createReadFileTool()]),
    });
    await runtime.send("read it");

    const { events, problems } = await store.inspect("written");
    assert.deepEqual(problems, []);
    assert.deepEqual(events.map((event) => event.kind), [
      "session",
      "message", // user
      "message", // assistant requesting the tool
      "usage",
      "message", // tool result — one line, not three
      "message", // assistant answer
      "usage",
    ]);

    const toolEvent = events.find(
      (event) => event.kind === "message" && event.message.role === "tool",
    );
    assert.ok(toolEvent && toolEvent.kind === "message");
    assert.deepEqual(
      Object.keys(toolEvent).sort(),
      ["at", "isError", "kind", "message", "runId", "step", "v"].sort(),
      "identity rides on the message event, not inside ChatMessage",
    );
    assert.equal(toolEvent.isError, false);
    assert.equal(toolEvent.step, 1, "the tool result belongs to the step that requested it");
    assert.ok(toolEvent.runId && toolEvent.runId.length > 0);
    assert.deepEqual(Object.keys(toolEvent.message).sort(), ["content", "role", "toolCallId"]);

    // Every turn of one send shares its run id; the user turn is step 0.
    const userEvent = events.find((event) => event.kind === "message" && event.message.role === "user");
    assert.ok(userEvent && userEvent.kind === "message");
    assert.equal(userEvent.runId, toolEvent.runId);
    assert.equal(userEvent.step, 0);
    assert.equal(userEvent.isError, undefined);

    const assistantEvent = events.find(
      (event) => event.kind === "message" && event.message.role === "assistant",
    );
    assert.ok(assistantEvent && assistantEvent.kind === "message");
    assert.equal(assistantEvent.runId, toolEvent.runId);
    assert.equal(assistantEvent.step, toolEvent.step, "a result carries the step of the request it answers");
  });

  it("tolerates a legacy audit line with missing fields instead of failing the session", async () => {
    // Before ADR-0001 these kinds were shape-checked before dispatch, so a legacy
    // line lacking `callId`/`name` made the whole session unreadable. They are no
    // longer written, so a well-formed-JSON-but-incomplete legacy line degrades to
    // "unknown but ignorable" while the transcript beside it still reads.
    const legacyIncomplete = `{"v":1,"kind":"tool/result","ignorable":true,"at":"2026-09-24T00:00:05.000Z"}`;
    const withIncomplete = V1_HALF_BATCH.replace(
      `{"v":1,"kind":"tool/result","ignorable":true,"at":"2026-09-24T00:00:04.000Z","callId":"c9","name":"read_file","content":"file contents here","isError":false}`,
      legacyIncomplete,
    );
    const { store } = await seeded("golden-incomplete", "half", withIncomplete);

    const { problems } = await store.inspect("half");
    assert.deepEqual(problems, []);
    assert.deepEqual(
      (await store.history("half")).map((message) => message.role),
      ["user", "assistant"],
      "the transcript is unaffected by an unreadable audit line",
    );
    // With the result unreadable, recovery must say the outcome is unknown — it
    // must not invent the content that line would have carried.
    assert.equal(await store.recover("half"), 1);
    assert.match((await store.history("half")).at(-1)!.content, /outcome unknown/);

    assert.equal(migrateEvent({ v: 1, kind: "tool/call", ignorable: true }), null);
    assert.equal(migrateEvent({ v: 1, kind: "tool/result", ignorable: true }), null);
    assert.equal(
      migrateEvent({
        v: 1,
        kind: "tool/result",
        ignorable: true,
        at: "2026-09-24T00:00:05.000Z",
        callId: "c1",
        name: "read_file",
        content: "kept",
        isError: false,
      })?.kind,
      "tool/result",
      "a well-formed legacy result is still understood, for repair fidelity",
    );
  });

  it("treats a compaction record as a known kind, not as an unknown ignorable one", async () => {
    // `summary` is written with ignorable:true so an older reader skips it, but a
    // current reader must understand it rather than dismiss it — otherwise the
    // boundary would be lost and the prompt would silently be the full history.
    const fixture = await createTestFixture("summary-kind");
    const store = new SessionStore({ root: fixture.storeRoot });
    await store.create("s");
    await store.appendMessage("s", { role: "user", content: "one" });
    const written = await store.appendSummary("s", { covers: 1, summary: "the user said one" });

    assert.equal(written.kind, "summary");
    assert.equal(written.ignorable, true, "an older reader drops it and sees the full history");
    const line = (await readFile(store.pathFor("s"), "utf8")).trim().split("\n").at(-1)!;
    assert.deepEqual(migrateEvent(JSON.parse(line)), written, "the recorded line round-trips");

    // The boundary survives a fresh read of the file.
    assert.equal((await store.compaction("s"))?.summary, "the user said one");
    assert.equal((await store.history("s")).length, 1, "and the message it covers is still there");

    // A summary line with no usable boundary is a reported problem, not a silent skip.
    await writeFile(store.pathFor("s"), `{"v":1,"kind":"summary","ignorable":true,"at":"2026-09-24T00:00:06.000Z","summary":"no boundary"}\n`, { encoding: "utf8", flag: "a" });
    const report = await store.inspect("s");
    assert.equal(report.problems.length, 1);
    assert.match(report.problems[0]!.detail, /covers must be a non-negative integer/);
  });

  it("keeps the reasoning token share in the usage record, and old logs without it valid", async () => {
    const fixture = await createTestFixture("usage-reasoning");
    const store = new SessionStore({ root: fixture.storeRoot });
    await store.create("r");
    // Old shape first: a log written before this field existed must stay valid and
    // must not report a confident zero for a number nobody measured.
    await store.appendUsage("r", { inputTokens: 5, outputTokens: 6 });
    assert.deepEqual(await store.totals("r"), { inputTokens: 5, outputTokens: 6 });

    await store.appendUsage("r", { inputTokens: 16, outputTokens: 131, reasoningTokens: 119 });
    assert.deepEqual(await store.totals("r"), { inputTokens: 21, outputTokens: 137, reasoningTokens: 119 },
      "the share is summed separately and never folded into outputTokens");

    // The recorded line round-trips through the same parser a later read uses.
    const line = (await readFile(store.pathFor("r"), "utf8")).trim().split("\n").at(-1)!;
    assert.deepEqual(migrateEvent(JSON.parse(line)), JSON.parse(line), "the usage line round-trips");

    // A malformed share is a reported problem, not a silently dropped number.
    await writeFile(store.pathFor("r"),
      `{"v":1,"kind":"usage","at":"2026-09-24T00:00:09.000Z","usage":{"inputTokens":1,"outputTokens":2,"reasoningTokens":-3}}\n`,
      { encoding: "utf8", flag: "a" });
    const report = await store.inspect("r");
    assert.equal(report.problems.length, 1);
    assert.match(report.problems[0]!.detail, /reasoningTokens must be a nonnegative safe integer/);
  });

  it("still reports a torn line as a syntax problem, because JSON.parse fails first", async () => {
    // The ignorable hatch cannot apply to a line that is not JSON at all: there is
    // nothing to dispatch on. This is the pre-existing interrupted-write signal and
    // must not be quietly reclassified as "handled" by ADR-0001.
    const torn = V1_COMPLETE.replace(
      `{"v":1,"kind":"tool/result","ignorable":true,"at":"2026-09-24T00:00:05.000Z","callId":"c1","name":"read_file","content":"file contents here","isError":false}`,
      `{"v":1,"kind":"tool/result","ignorable":true,"at":"2026-09-24T00:00:05.000Z","callId":`,
    );
    const { store } = await seeded("golden-torn", "golden", torn);

    const { problems } = await store.inspect("golden");
    assert.equal(problems.length, 1);
    assert.equal(problems[0]!.line, 6);
    assert.match(problems[0]!.detail, /invalid JSON/);
    assert.ok(!problems[0]!.detail.includes("file contents here"), "raw content stays hidden");
  });

  it("still reconstructs the same conversation from a legacy log that carries the audit pair", async () => {
    const { store } = await seeded("golden-skip", "golden", V1_COMPLETE);
    const all = await store.read("golden");
    const auditFree = all.filter((event) => event.kind !== "tool/call" && event.kind !== "tool/result");
    assert.equal(all.length - auditFree.length, 2, "legacy pairs are still parsed, not dropped outright");

    // History comes from messages either way: the pair never was the source.
    const messages = auditFree.filter((event) => event.kind === "message").map((event) => event.message);
    assert.deepEqual(messages, await store.history("golden"));
    assert.deepEqual(auditFree.filter((event) => event.kind === "usage").length, 2);

    // The ignorable hatch applies to kinds the reader does not know at all.
    assert.equal(migrateEvent({ v: 1, kind: "future/thing", ignorable: true }), null);
    assert.throws(() => migrateEvent({ v: 1, kind: "future/thing" }), /unknown event kind/);
  });
});