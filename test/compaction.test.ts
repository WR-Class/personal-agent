/**
 * Compaction fidelity.
 *
 * The claim under test is narrow and checkable: compaction changes **what the
 * model is shown**, never what is stored. Every original message stays readable,
 * the boundary is an observed count rather than a claim, and the summary the
 * model later sees is byte-identical to the one that was recorded.
 *
 * Nothing here claims the summary is *good* — only that it is not silently
 * altered, not applied to a range it did not cover, and not applied at all when
 * the conversation is in a state where suppressing messages would lose meaning.
 */

import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { AgentRuntime } from "../src/runtime.ts";
import { SessionStore } from "../src/session-store.ts";
import { ToolRegistry, createReadFileTool } from "../src/tools.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { createTestFixture } from "./fixtures.ts";
import type { ChatMessage } from "../src/types.ts";

let home = "";
let workspaceRoot = "";

/** One fixture for the whole file; each test uses its own session id inside it. */
const fixture = await createTestFixture("compaction");
home = fixture.storeRoot;
workspaceRoot = fixture.workspaceRoot;
await writeFile(join(workspaceRoot, "notes.txt"), "SIDE-CHANNEL-CONTENT\n", "utf8");

const MARKER = "UNIQUE-FACT-7f3a9c";

function runtime(
  sessionId: string,
  steps: Parameters<typeof createScriptedAdapter>[0]["steps"],
  overrides: Partial<ConstructorParameters<typeof AgentRuntime>[0]> = {},
): AgentRuntime {
  return new AgentRuntime({
    adapter: createScriptedAdapter({ steps, model: "summary-model" }),
    store: new SessionStore({ root: home }),
    sessionId,
    home,
    workspaceRoot,
    tools: new ToolRegistry([createReadFileTool()]),
    systemPrompt: "You are a concise assistant.",
    ...overrides,
  });
}

describe("conversation compaction", () => {
  it("keeps every original message while shortening only the prompt", async () => {
    const store = new SessionStore({ root: home });
    const agent = runtime("fidelity-basic", [
      { content: `the user asked about ${MARKER}` },
      { content: `SUMMARY: the user asked about ${MARKER}` },
      { content: "second answer" },
    ]);
    await agent.send("first question");
    const before = await store.history("fidelity-basic");
    assert.equal(before.length, 2);

    const result = await agent.compact();
    assert.equal(result.covers, 2, "the boundary is the message count the store observed");

    // Nothing is deleted: the same two messages are still replayed in order.
    const after = await store.history("fidelity-basic");
    assert.deepEqual(after, before, "history is byte-identical after compaction");

    // And the next prompt carries the summary verbatim, with the covered messages gone.
    const send = await agent.send("second question");
    const texts = send.history.map((message) => message.content).join("\n");
    assert.ok(texts.includes(`SUMMARY: the user asked about ${MARKER}`), "the summary reaches the model verbatim");
    assert.ok(!texts.includes("first question"), "the covered turn is no longer sent");
    assert.ok(texts.includes("second question"), "the new turn is sent");
    assert.equal(send.compactedMessages, 2, "the send says how much it replaced");
  });

  it("records a boundary it actually observed, and refuses a forged one", async () => {
    const store = new SessionStore({ root: home });
    await store.create("boundary");
    await store.appendMessage("boundary", { role: "user", content: "one" });

    // Too large: the summary would claim to cover a turn it never saw.
    await assert.rejects(
      () => store.appendSummary("boundary", { covers: 5, summary: "s" }),
      /must equal this session's message count \(1\)/,
    );
    // Too small is equally wrong: it would leave the model a slice that starts
    // inside the conversation the summary describes.
    await assert.rejects(
      () => store.appendSummary("boundary", { covers: 0, summary: "s" }),
      /must equal this session's message count \(1\)/,
    );
    await assert.rejects(() => store.appendSummary("boundary", { covers: 1, summary: "   " }), /must not be empty/);

    const event = await store.appendSummary("boundary", { covers: 1, summary: "s" });
    assert.equal(event.covers, 1);
    assert.equal((await store.compaction("boundary"))?.summary, "s");

    // A malformed line is reported by position like any other corrupt line.
    await writeFile(store.pathFor("boundary"), `${JSON.stringify({ v: 1, kind: "summary", ignorable: true, at: "t", covers: -1, summary: "x" })}\n`, { encoding: "utf8", flag: "a" });
    const report = await store.inspect("boundary");
    assert.equal(report.problems.length, 1);
    assert.match(report.problems[0]!.detail, /covers must be a non-negative integer/);
  });

  it("refuses to compact while a tool batch is unanswered", async () => {
    // Summarizing here would let the model see an answer-shaped summary of a
    // question whose result never arrived. The batch is built directly so the
    // unfinished state is real, not simulated by a budget.
    const store = new SessionStore({ root: home });
    // Zero scripted replies: any model call during compaction would fail loudly,
    // which is itself evidence that the refusal happened before the call.
    const agent = runtime("pending-batch", []);
    await store.create("pending-batch");
    await store.appendMessage("pending-batch", { role: "user", content: "read it" });
    await store.appendMessage("pending-batch", {
      role: "assistant",
      content: "",
      toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"notes.txt"}' }],
    });

    const pending = await store.pendingTools("pending-batch");
    assert.equal(pending.length, 1, "the batch is genuinely unfinished");
    await assert.rejects(() => agent.compact(), /refusing to summarize while 1 tool result/);
    assert.equal(await store.compaction("pending-batch"), undefined, "no boundary was recorded");
  });

  it("refuses an empty summary and records nothing", async () => {
    const store = new SessionStore({ root: home });
    const agent = runtime("empty-summary", [{ content: "answer" }, { content: "   " }]);
    await agent.send("question");
    const linesBefore = (await store.inspect("empty-summary")).events.length;

    await assert.rejects(() => agent.compact(), /neither content nor tool calls|empty summary/);
    assert.equal(await store.compaction("empty-summary"), undefined);
    assert.equal((await store.inspect("empty-summary")).events.length, linesBefore, "nothing was appended");
  });

  it("chains a second compaction onto the first instead of resummarizing everything", async () => {
    const store = new SessionStore({ root: home });
    // Replies in call order: answer one, compaction-1, answer two, compaction-2, answer three.
    const agent = runtime("chained", [
      { content: "answer one" },
      { content: "SUMMARY-FIRST" },
      { content: "answer two" },
      { content: "SUMMARY-SECOND" },
      { content: "answer three" },
    ]);
    await agent.send("question one");
    await agent.compact();
    const afterFirst = await agent.send("question two");
    assert.ok(
      afterFirst.history.some((message) => message.content.includes("SUMMARY-FIRST")),
      "the first summary is what the next send sees",
    );
    assert.equal((await store.history("chained")).length, 4);

    const second = await agent.compact();
    assert.equal(second.covers, 4, "the boundary grew to cover the whole history");
    assert.equal((await store.compaction("chained"))?.summary, "SUMMARY-SECOND", "the latest summary wins");
    assert.equal((await store.history("chained")).length, 4, "still nothing deleted");

    const send = await agent.send("question three");
    const texts = send.history.map((message) => message.content).join("\n");
    assert.ok(texts.includes("SUMMARY-SECOND"));
    assert.ok(!texts.includes("SUMMARY-FIRST"), "the superseded summary is not also sent");
    assert.equal(send.compactedMessages, 4);
  });

  it("gives the summarizer no tools and does not persist the summarizing call as a turn", async () => {
    const store = new SessionStore({ root: home });
    const seen: ChatMessage[][] = [];
    const toolFields: (unknown)[] = [];
    const adapter = createScriptedAdapter({ steps: [{ content: "answer" }, { content: "SUMMARY-TEXT" }], model: "summary-model" });
    const recording = {
      id: adapter.id,
      defaultModel: adapter.defaultModel,
      chat: async (request: Parameters<typeof adapter.chat>[0], signal?: AbortSignal) => {
        seen.push([...request.messages]);
        toolFields.push(request.tools);
        return adapter.chat(request, signal);
      },
    };
    const agent = new AgentRuntime({
      adapter: recording,
      store,
      sessionId: "no-tools",
      home,
      workspaceRoot,
      tools: new ToolRegistry([createReadFileTool()]),
      systemPrompt: "You are a concise assistant.",
    });
    await agent.send("hello");
    const beforeCompaction = (await store.history("no-tools")).length;
    await agent.compact();

    assert.equal(seen.length, 2, "one send call, one compaction call");
    assert.ok(Array.isArray(toolFields[0]) && toolFields[0]!.length > 0, "the normal send does offer read_file");
    assert.equal(toolFields[1], undefined, "the summarizing call is given no tools at all");
    assert.equal((await store.history("no-tools")).length, beforeCompaction, "compaction added no message");
    const request = seen[1]!;
    assert.ok(request.some((message) => message.content.includes("Summarize the conversation")), "the summarizer was instructed");
    assert.ok(request.some((message) => message.content.includes("hello")), "and shown the conversation");
    const events = (await store.inspect("no-tools")).events;
    assert.equal(events.filter((event) => event.kind === "summary").length, 1);
    assert.equal(events.filter((event) => event.kind === "message").length, beforeCompaction);
  });

  it("stays a no-op for a reader that skips the summary event", async () => {
    // The compatibility claim: an older reader drops the `ignorable` summary and
    // builds the full prompt — longer than intended, never wrong.
    const store = new SessionStore({ root: home });
    const agent = runtime("legacy-reader", [{ content: "answer" }, { content: "SUMMARY-LEGACY" }, { content: "later" }]);
    await agent.send("question");
    await agent.compact();
    const raw = await store.inspect("legacy-reader");
    const summaryEvents = raw.events.filter((event) => event.kind === "summary");
    assert.equal(summaryEvents.length, 1);
    assert.equal((summaryEvents[0] as { ignorable?: boolean }).ignorable, true);
    // Dropping it leaves exactly the conversation that was there before.
    assert.equal((await store.history("legacy-reader")).length, 2);
  });

  it("is refused while a send is in flight, and refuses to compact an empty session", async () => {
    const agent = runtime("guards", [{ content: "ok" }, { content: "ok again" }]);
    await assert.rejects(() => agent.compact(), /nothing to compact/);
    await agent.send("hi");
    const inFlight = agent.send("second");
    await assert.rejects(() => agent.compact(), /send is in flight/);
    await inFlight;
  });
});
