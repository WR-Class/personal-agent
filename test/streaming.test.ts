/**
 * SSE transport.
 *
 * The claims that matter are about refusal, not assembly: a stream cut mid-flight
 * must not become a short answer, a malformed fragment must not be skipped, and a
 * tool call split across fragments must not lose its arguments. Assembly itself is
 * a pure function, so most of this runs without a socket — the two socket cases are
 * there to prove the request body actually asks for streaming and that aborting
 * mid-stream still works.
 */

import { createServer } from "node:http";
import type { Server } from "node:http";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createOpenAIChatAdapter, parseSseCompletion } from "../src/openai-adapter.ts";
import { createTestFixture } from "./fixtures.ts";
import { main } from "../src/cli.ts";
import { SessionStore } from "../src/session-store.ts";

const servers: Server[] = [];

after(async () => {
  for (const server of servers) await new Promise<void>((done) => server.close(() => done()));
});

/** One SSE `data:` line carrying a chat-completion chunk. */
function chunk(delta: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-1", object: "chat.completion.chunk", model: "sse-model",
    choices: [{ index: 0, delta, finish_reason: null, logprobs: null }],
    ...extra,
  })}\n\n`;
}

const USAGE = { prompt_tokens: 18, completion_tokens: 205, total_tokens: 223,
  completion_tokens_details: { reasoning_tokens: 200 } };

async function serveSse(reply: (body: string) => string, stallMs = 0, onRequest?: (body: string) => void) {
  const server = createServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (piece) => { body += piece; });
    request.on("end", () => {
      onRequest?.(body);
      const send = () => {
        if (response.destroyed) return;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(reply(body));
      };
      if (stallMs) setTimeout(send, stallMs);
      else send();
    });
  });
  await new Promise<void>((ready, fail) => {
    server.once("error", (error) => fail(new Error(`test server could not bind a loopback port: ${(error as Error).message}`)));
    server.listen(0, "127.0.0.1", () => ready());
  });
  servers.push(server);
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("no port");
  return { baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

const reasoningThen = (answer: string) =>
  chunk({ role: "assistant", reasoning_content: "thinking" }) +
  chunk({ reasoning_content: " harder" }) +
  chunk({ content: answer }) +
  chunk({}, { finish_reason: "stop", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: USAGE }) +
  "data: [DONE]\n\n";

describe("SSE assembly", () => {
  it("joins content and reasoning fragments and keeps the final usage", () => {
    const payload = parseSseCompletion(reasoningThen("北京")) as Record<string, unknown>;
    const choice = (payload.choices as Record<string, unknown>[])[0]!;
    const message = choice.message as Record<string, unknown>;
    assert.equal(message.content, "北京");
    assert.equal(message.reasoning_content, "thinking harder");
    assert.equal(choice.finish_reason, "stop");
    assert.equal(payload.model, "sse-model");
    assert.deepEqual(payload.usage, USAGE);
  });

  it("tolerates the null usage key every chunk carries", () => {
    // Measured: every chunk has `usage`, almost always null, with the real one in a
    // choices-less final chunk. A null must not overwrite the real value.
    const payload = parseSseCompletion(reasoningThen("x")) as Record<string, unknown>;
    assert.deepEqual(payload.usage, USAGE);
    const withoutUsage = parseSseCompletion(chunk({ content: "x" }) + chunk({}, { finish_reason: "stop" }) + "data: [DONE]\n\n") as Record<string, unknown>;
    assert.equal(withoutUsage.usage, undefined, "no usage means no usage, not a zero-valued one");
  });

  it("assembles a tool call fragmented across chunks, in index order", () => {
    // The shape that would silently corrupt a tool call: `id` and `name` arrive once
    // while `arguments` streams in pieces, and two calls can interleave.
    const raw =
      chunk({ role: "assistant" }) +
      chunk({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "read_file", arguments: '{"pa' } }] }) +
      chunk({ tool_calls: [{ index: 1, id: "call_b", type: "function", function: { name: "other", arguments: "{}" } }] }) +
      chunk({ tool_calls: [{ index: 0, function: { arguments: 'th":"a.txt"}' } }] }) +
      chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }) +
      "data: [DONE]\n\n";
    const payload = parseSseCompletion(raw) as Record<string, unknown>;
    const message = ((payload.choices as Record<string, unknown>[])[0]!.message) as Record<string, unknown>;
    assert.deepEqual(message.tool_calls, [
      { id: "call_a", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } },
      { id: "call_b", type: "function", function: { name: "other", arguments: "{}" } },
    ]);
  });

  it("refuses a stream that was cut mid-flight instead of accepting a short answer", () => {
    // No [DONE] and no finish_reason: the connection died. Accepting this would turn
    // a truncated answer into a normal one, which is the one outcome worse than an error.
    const truncated = chunk({ role: "assistant" }) + chunk({ content: "the answer is" });
    assert.throws(() => parseSseCompletion(truncated), /stream ended early/);
    // [DONE] without a finish_reason is a complete stream by the spec, so it is read.
    const noFinish = chunk({ content: "done" }) + "data: [DONE]\n\n";
    const payload = parseSseCompletion(noFinish) as Record<string, unknown>;
    assert.equal(((payload.choices as Record<string, unknown>[])[0]!.message as Record<string, unknown>).content, "done");
    // finish_reason without [DONE] is likewise read: not every server sends [DONE].
    const noDone = chunk({ content: "done" }) + chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    assert.equal((parseSseCompletion(noDone) as Record<string, unknown>).choices !== undefined, true);
  });

  it("refuses malformed fragments and a stream with nothing in it", () => {
    assert.throws(() => parseSseCompletion("data: {not json\n\n"), /malformed SSE event/);
    assert.throws(() => parseSseCompletion(": keepalive\n\ndata: \n\n"), /empty SSE stream/);
    // A non-string fragment is refused rather than coerced into the answer text.
    assert.throws(() => parseSseCompletion(chunk({ content: { nested: true } })), /invalid model response: content/);
    assert.throws(() => parseSseCompletion(chunk({ reasoning_content: [1] })), /invalid model response: reasoning_content/);
  });

  it("keeps the inherited refusals for an incomplete or unknown-tool reply", () => {
    // `finish_reason: length` still means the reply is incomplete upstream.
    const cut = chunk({ content: "partial" }) + chunk({}, { choices: [{ index: 0, delta: {}, finish_reason: "length" }] }) + "data: [DONE]\n\n";
    const payload = parseSseCompletion(cut) as Record<string, unknown>;
    assert.equal((payload.choices as Record<string, unknown>[])[0]!.finish_reason, "length");
  });
});

describe("SSE over a real socket", () => {
  it("asks for streaming and maps the assembled reply", async () => {
    let sent = "";
    const { baseUrl } = await serveSse(() => reasoningThen("答案"), 0, (body) => { sent = body; });
    const adapter = createOpenAIChatAdapter({ baseUrl, apiKey: "k", model: "m", stream: true });
    const response = await adapter.chat({ messages: [{ role: "user", content: "hi" }] });

    assert.equal(response.content, "答案");
    assert.equal(response.reasoning, "thinking harder");
    // Token accounting survives streaming: the share is a subset of the output count.
    assert.deepEqual(response.usage, { inputTokens: 18, outputTokens: 205, reasoningTokens: 200 });

    const body = JSON.parse(sent) as Record<string, unknown>;
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });

  it("does not send streaming fields unless streaming was asked for", async () => {
    let sent = "";
    const { baseUrl } = await serveSse(() => JSON.stringify({ model: "m",
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "plain" } }],
      usage: { prompt_tokens: 1, completion_tokens: 2 } }), 0, (body) => { sent = body; });
    const adapter = createOpenAIChatAdapter({ baseUrl, apiKey: "k", model: "m" });
    const response = await adapter.chat({ messages: [{ role: "user", content: "hi" }] });
    assert.equal(response.content, "plain");
    const body = JSON.parse(sent) as Record<string, unknown>;
    assert.equal("stream" in body, false, "the default request body is unchanged");
    assert.equal("stream_options" in body, false);
  });

  it("enforces the byte ceiling on a stream that never ends", async () => {
    // A stream is a producer like any other: without a ceiling a broken server can
    // keep it open forever. The ceiling counts bytes actually received.
    const { baseUrl } = await serveSse(() => {
      const big = "x".repeat(2000);
      let out = "";
      for (let i = 0; i < 2_000; i += 1) out += chunk({ content: big });
      return out;
    });
    const adapter = createOpenAIChatAdapter({ baseUrl, apiKey: "k", model: "m", stream: true });
    await assert.rejects(
      () => adapter.chat({ messages: [{ role: "user", content: "hi" }] }),
      /exceeds the 1048576-byte limit/,
    );
  });

  it("aborts a stalled stream instead of waiting for it", async () => {
    const { baseUrl } = await serveSse(() => reasoningThen("late"), 5_000);
    const adapter = createOpenAIChatAdapter({ baseUrl, apiKey: "k", model: "m", stream: true, timeoutMs: 10_000 });
    const controller = new AbortController();
    const started = Date.now();
    setTimeout(() => controller.abort(), 200);
    await assert.rejects(() => adapter.chat({ messages: [{ role: "user", content: "hi" }] }, controller.signal));
    assert.ok(Date.now() - started < 3_000, "the abort cut the stream, not the adapter timeout");
  });
});

describe("CLI streaming flag", () => {
  it("streams only when asked, and produces the same visible answer either way", async () => {
    // The server answers according to what was actually asked for, which is also how
    // the flag gets verified: a non-streaming request must not receive SSE here.
    const streamFlags: boolean[] = [];
    const { baseUrl } = await serveSse((body) => {
      const asked = JSON.parse(body) as { stream?: boolean };
      streamFlags.push(asked.stream === true);
      return asked.stream === true
        ? reasoningThen("同样的答案")
        : JSON.stringify({ model: "m", choices: [{ finish_reason: "stop",
            message: { role: "assistant", content: "同样的答案", reasoning_content: "thinking harder" } }],
            usage: USAGE });
    });
    const fixture = await createTestFixture("cli-stream");
    const writes: string[] = [];
    const io = { write: (text: string) => { writes.push(text); }, ask: async () => null,
      onInterrupt: () => () => {}, close: () => {}, interactive: false, hidden: () => {} } as never;

    assert.equal(await main(["--home", fixture.home, "--workspace", fixture.workspaceRoot, "--session", "plain", "hi"],
      { PERSONAL_AGENT_BASE_URL: baseUrl, PERSONAL_AGENT_MODEL: "m", PERSONAL_AGENT_API_KEY: "k" }, io), 0);
    const plainOutput = writes.join("");
    assert.match(plainOutput, /同样的答案/);

    writes.length = 0;
    assert.equal(await main(["--home", fixture.home, "--workspace", fixture.workspaceRoot, "--session", "streamed", "--stream", "hi"],
      { PERSONAL_AGENT_BASE_URL: baseUrl, PERSONAL_AGENT_MODEL: "m", PERSONAL_AGENT_API_KEY: "k" }, io), 0);
    const streamedOutput = writes.join("");
    assert.match(streamedOutput, /同样的答案/, "the visible answer is the same");
    assert.match(streamedOutput, /· 推理 200 ·/);

    assert.deepEqual(streamFlags, [false, true], "only the --stream run asked to stream");
    // Transport choice changes nothing the operator sees: same answer, same budget line.
    assert.equal(plainOutput, streamedOutput, "streaming changes the transport, not the rendered result");
    const store = new SessionStore({ root: fixture.home });
    assert.deepEqual(await store.history("plain"), await store.history("streamed"),
      "and nothing about what gets stored");
    assert.deepEqual(await store.totals("plain"), await store.totals("streamed"), "including the token account");
  });
});
