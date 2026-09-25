/**
 * Provider integration over a real socket.
 *
 * These tests do **not** call an external provider: no credential exists here, so
 * claiming a live-provider run would be a fabrication. What they do exercise is
 * every layer between the runtime and the network — a real `node:http` server
 * bound to 127.0.0.1, the real global `fetch`, real request bytes, the real
 * adapter error mapping, and the real CLI entry point writing a real transcript.
 *
 * What is therefore *verified*: the wire shape this client sends, how it reacts
 * to genuine HTTP failures, real abort-on-deadline behaviour, and an end-to-end
 * CLI run against a server that is not a mocked function call.
 *
 * What is *not* verified here, and must not be implied by a passing run: that any
 * particular hosted provider accepts this shape, whether its model names or token
 * accounting behave as expected, or anything about TLS, proxies, or rate limits.
 */

import type { IncomingMessage } from "node:http";
import { createTestFixture } from "./fixtures.ts";
import { closeAllServers, startTestServer } from "./server-fixture.ts";
import type { TestServer } from "./server-fixture.ts";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import assert from "node:assert/strict";

import { createOpenAIChatAdapter } from "../src/openai-adapter.ts";
import { AgentRuntime, DeadlineExceededError } from "../src/runtime.ts";
import { SessionStore } from "../src/session-store.ts";
import { ToolRegistry, createReadFileTool } from "../src/tools.ts";
import { main } from "../src/cli.ts";

const fixture = await createTestFixture("provider-integration");
const servers: TestServer[] = [];
// The tool loop below reads this through the real read_file tool.
await writeFile(join(fixture.workspaceRoot, "notes.txt"), "SIDE-CHANNEL-CONTENT\n", "utf8");

after(async () => {
  await closeAllServers(servers);
});

interface Captured {
  method: string;
  url: string;
  headers: IncomingMessage["headers"];
  body: string;
}

/**
 * Start a server that answers with `reply(index)` and records every request.
 * Real HTTP on an ephemeral loopback port; nothing here is stubbed.
 */
async function serve(reply: (captured: Captured, index: number) => { status?: number; headers?: Record<string, string>; body?: string; stallMs?: number }) {
  const captured: Captured[] = [];
  const started = await startTestServer((request, response) => {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      const entry: Captured = { method: request.method ?? "", url: request.url ?? "", headers: request.headers, body };
      captured.push(entry);
      let outcome;
      try { outcome = reply(entry, captured.length - 1); }
      catch (error) { response.destroy(error as Error); return; }
      const send = () => {
        if (response.destroyed) return;
        response.writeHead(outcome.status ?? 200, { "content-type": "application/json", ...(outcome.headers ?? {}) });
        response.end(outcome.body ?? "{}");
      };
      // `stallMs` leaves the request unanswered so a client deadline has something
      // real to cut off; the socket closing is the observable effect.
      if (outcome.stallMs) setTimeout(send, outcome.stallMs);
      else send();
    });
  });
  servers.push(started);
  return { baseUrl: `http://127.0.0.1:${started.port}/v1`, captured };
}

function completion(content: string, extra: Record<string, unknown> = {}) {
  return JSON.stringify({
    model: "local-test-model",
    choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
    usage: { prompt_tokens: 11, completion_tokens: 4 },
    ...extra,
  });
}

describe("OpenAI-compatible adapter over a real socket", () => {
  it("sends the documented wire shape and maps a plain reply", async () => {
    const { baseUrl, captured } = await serve(() => ({ body: completion("hello from the server") }));
    const adapter = createOpenAIChatAdapter({ baseUrl, apiKey: "LOCAL-TEST-KEY", model: "local-test-model" });
    const response = await adapter.chat({
      messages: [
        { role: "system", content: "sys" },
        { role: "user", content: "hi" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "read_file", arguments: '{"path":"a.txt"}' }] },
        { role: "tool", content: "file body", toolCallId: "c1" },
      ],
      tools: [{ name: "read_file", description: "Read a file", parameters: { type: "object", properties: {}, required: [] } }],
      temperature: 0.2,
    });

    assert.equal(response.content, "hello from the server");
    assert.equal(response.model, "local-test-model");
    assert.deepEqual(response.usage, { inputTokens: 11, outputTokens: 4 });

    assert.equal(captured.length, 1);
    const request = captured[0]!;
    assert.equal(request.method, "POST");
    assert.equal(request.url, "/v1/chat/completions");
    assert.equal(request.headers.authorization, "Bearer LOCAL-TEST-KEY");
    assert.match(String(request.headers["content-type"]), /application\/json/);

    const body = JSON.parse(request.body) as Record<string, any>;
    assert.equal(body.model, "local-test-model");
    assert.equal(body.temperature, 0.2);
    assert.equal(body.messages[2].tool_calls[0].type, "function");
    assert.equal(body.messages[2].tool_calls[0].function.name, "read_file");
    assert.equal(body.messages[3].tool_call_id, "c1");
    assert.equal(body.tools[0].type, "function");
    assert.equal(body.tools[0].function.name, "read_file");
  });

  it("reports an HTTP failure without echoing the server body", async () => {
    const secret = "LEAKED-FRAGMENT-9911";
    const { baseUrl } = await serve(() => ({ status: 401, body: `{"error":{"message":"bad key ${secret}"}}` }));
    const adapter = createOpenAIChatAdapter({ baseUrl, apiKey: "wrong", model: "m" });
    await assert.rejects(
      () => adapter.chat({ messages: [{ role: "user", content: "hi" }] }),
      (error: unknown) => {
        assert.match((error as Error).message, /HTTP 401/);
        assert.ok(!(error as Error).message.includes(secret), "the response body is never included in the error");
        return true;
      },
    );
  });

  it("refuses a 200 that is not the expected JSON", async () => {
    const { baseUrl } = await serve(() => ({ status: 200, headers: { "content-type": "text/html" }, body: "<html>proxy error page</html>" }));
    const adapter = createOpenAIChatAdapter({ baseUrl, apiKey: "k", model: "m" });
    await assert.rejects(() => adapter.chat({ messages: [{ role: "user", content: "hi" }] }), /non-JSON body/);
  });

  it("refuses an incomplete reply instead of persisting it", async () => {
    const { baseUrl } = await serve(() => ({
      body: JSON.stringify({
        model: "m",
        choices: [{ finish_reason: "length", message: { role: "assistant", content: "truncated", tool_calls: [{ id: "c1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }] } }],
      }),
    }));
    const adapter = createOpenAIChatAdapter({ baseUrl, apiKey: "k", model: "m" });
    await assert.rejects(() => adapter.chat({ messages: [{ role: "user", content: "hi" }] }), /incomplete: length/);
  });

  it("carries a tool call back over HTTP and executes it locally", async () => {
    // A full loop against a real server: request → tool call → local execution →
    // the tool result sent back as a `tool` message → final reply.
    const { baseUrl, captured } = await serve((_request, index) =>
      index === 0
        ? {
            body: JSON.stringify({
              model: "local-test-model",
              choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [{ id: "call-1", type: "function", function: { name: "read_file", arguments: '{"path":"notes.txt"}' } }] } }],
              usage: { prompt_tokens: 20, completion_tokens: 9 },
            }),
          }
        : { body: completion("the note says SIDE-CHANNEL-CONTENT") },
    );
    const runtime = new AgentRuntime({
      adapter: createOpenAIChatAdapter({ baseUrl, apiKey: "k", model: "local-test-model" }),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: "http-tool-loop",
      home: fixture.home,
      workspaceRoot: fixture.workspaceRoot,
      tools: new ToolRegistry([createReadFileTool()]),
      systemPrompt: "concise",
    });

    const result = await runtime.send("read the note");
    assert.equal(result.reply.content, "the note says SIDE-CHANNEL-CONTENT");
    assert.equal(result.toolCalls, 1);
    assert.equal(result.steps, 2);
    assert.equal(captured.length, 2);

    const second = JSON.parse(captured[1]!.body) as { messages: Array<Record<string, unknown>> };
    const toolMessage = second.messages.find((message) => message.role === "tool");
    assert.ok(toolMessage, "the tool result is sent back as a tool message");
    assert.equal(toolMessage.tool_call_id, "call-1");
    assert.equal(toolMessage.content, "SIDE-CHANNEL-CONTENT\n");

    // The assistant's tool call is recorded once, as a message the next prompt is
    // rebuilt from — not duplicated as a legacy audit event.
    const lines = (await readFile(new SessionStore({ root: fixture.storeRoot }).pathFor("http-tool-loop"), "utf8")).trim().split("\n");
    assert.equal(lines.filter((line) => line.includes('"tool/call"')).length, 0);
    assert.equal(lines.filter((line) => line.includes('"tool/result"')).length, 0);
    // The file body is recorded exactly once, in the single tool message. (The
    // final assistant reply quotes the marker too, so count by role.)
    const toolLines = lines.filter((line) => line.includes('"role":"tool"'));
    assert.equal(toolLines.length, 1, "one tool message, no duplicate record");
    assert.match(toolLines[0]!, /SIDE-CHANNEL-CONTENT/);
  });

  it("aborts a stalled request when the send deadline expires", async () => {
    const { baseUrl } = await serve(() => ({ stallMs: 5_000, body: completion("too late") }));
    const runtime = new AgentRuntime({
      adapter: createOpenAIChatAdapter({ baseUrl, apiKey: "k", model: "m", timeoutMs: 10_000 }),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: "http-deadline",
      home: fixture.home,
      workspaceRoot: fixture.workspaceRoot,
      deadlineMs: 400,
    });
    const started = Date.now();
    await assert.rejects(
      () => runtime.send("wait for it"),
      (error: unknown) => {
        assert.ok(error instanceof DeadlineExceededError, `expected a deadline error, got ${String(error)}`);
        return true;
      },
    );
    // The deadline is what cut it off, not the adapter's own 10s timeout.
    assert.ok(Date.now() - started < 4_000, "the send gave up on our deadline, not the provider timeout");
  });
});

describe("reasoning traces from a real provider", () => {
  /** The exact shape the operator's live endpoint emits, measured, not assumed. */
  function reasoningCompletion(reasoning: unknown) {
    return JSON.stringify({
      model: "local-test-model",
      choices: [{ index: 0, finish_reason: "stop",
        message: { role: "assistant", content: "**2**", reasoning_content: reasoning } }],
      usage: { prompt_tokens: 16, completion_tokens: 131, total_tokens: 147,
        completion_tokens_details: { reasoning_tokens: 119 } },
    });
  }

  it("reads the trace and its token share without treating the share as a delta", async () => {
    const { baseUrl } = await serve(() => ({ body: reasoningCompletion("Add one and one.") }));
    const adapter = createOpenAIChatAdapter({ baseUrl, apiKey: "k", model: "m" });
    const response = await adapter.chat({ messages: [{ role: "user", content: "1+1=?" }] });
    assert.equal(response.content, "**2**");
    assert.equal(response.reasoning, "Add one and one.");
    // 119 of 131, not 131 + 119.
    assert.deepEqual(response.usage, { inputTokens: 16, outputTokens: 131, reasoningTokens: 119 });
  });

  it("reports no trace when there is none, and refuses a malformed one", async () => {
    const plain = await serve(() => ({ body: completion("hi") }));
    const adapter = createOpenAIChatAdapter({ baseUrl: plain.baseUrl, apiKey: "k", model: "m" });
    const response = await adapter.chat({ messages: [{ role: "user", content: "x" }] });
    assert.equal(response.reasoning, undefined, "absent means absent, not an empty string");
    assert.deepEqual(response.usage, { inputTokens: 11, outputTokens: 4 }, "and no zero-valued share either");

    // A non-string trace would render as `[object Object]` if coerced.
    const nested = await serve(() => ({ body: reasoningCompletion({ text: "nested" }) }));
    const nestedAdapter = createOpenAIChatAdapter({ baseUrl: nested.baseUrl, apiKey: "k", model: "m" });
    await assert.rejects(() => nestedAdapter.chat({ messages: [{ role: "user", content: "x" }] }), /reasoning_content/);

    // `null` is how a provider spells "none"; that is not malformed.
    const nulled = await serve(() => ({ body: reasoningCompletion(null) }));
    const nullAdapter = createOpenAIChatAdapter({ baseUrl: nulled.baseUrl, apiKey: "k", model: "m" });
    const nullResponse = await nullAdapter.chat({ messages: [{ role: "user", content: "x" }] });
    assert.equal(nullResponse.reasoning, undefined);
  });

  it("never sends a reasoning trace back on the wire", async () => {
    // Reasoning lives on the response, not on ChatMessage, so this is a property of
    // the type shape — asserted anyway, because a future refactor could move it, and
    // silently replaying a model's private reasoning is not recoverable.
    const { baseUrl, captured } = await serve(() => ({ body: reasoningCompletion("SECRET-THOUGHT") }));
    const adapter = createOpenAIChatAdapter({ baseUrl, apiKey: "k", model: "m" });
    const first = await adapter.chat({ messages: [{ role: "user", content: "hello" }] });
    assert.equal(first.reasoning, "SECRET-THOUGHT");
    // Continue the way the runtime does: from persisted messages alone.
    await adapter.chat({ messages: [{ role: "user", content: "hello" }, { role: "assistant", content: first.content }] });
    assert.ok(!captured[1]!.body.includes("SECRET-THOUGHT"), "the trace is not replayed");
  });

  it("shows the trace before the answer and its share in the budget line", async () => {
    const { baseUrl } = await serve(() => ({ body: reasoningCompletion("think first") }));
    const fixture3 = await createTestFixture("provider-cli-reasoning");
    const writes: string[] = [];
    const code = await main(
      ["--home", fixture3.home, "--workspace", fixture3.workspaceRoot, "--session", "reason", "1+1=?"],
      { PERSONAL_AGENT_BASE_URL: baseUrl, PERSONAL_AGENT_MODEL: "local-test-model", PERSONAL_AGENT_API_KEY: "k" },
      { write: (text: string) => { writes.push(text); }, ask: async () => null, onInterrupt: () => () => {},
        close: () => {}, interactive: false, hidden: () => {} } as never,
    );
    assert.equal(code, 0);
    const output = writes.join("");
    assert.ok(output.indexOf("[思考] think first") < output.indexOf("**2**"), "the trace explains the answer, so it reads first");
    assert.match(output, /· 推理 119 ·/);
    // The share is not added into the ceiling arithmetic: 16 is the prompt count.
    assert.match(output, /令牌 16\/131072/);
  });
});

describe("CLI against a local provider", () => {
  it("completes a real one-shot turn, prints the budget, and never logs the key", async () => {
    const { baseUrl, captured } = await serve(() => ({ body: completion("answer from a real socket") }));
    const apiKey = "LOCAL-SOCKET-KEY-4242";
    const fixture2 = await createTestFixture("provider-cli");
    const writes: string[] = [];
    const exitCode = await main(
      ["--home", fixture2.home, "--workspace", fixture2.workspaceRoot, "--session", "live", "hello there"],
      { PERSONAL_AGENT_BASE_URL: baseUrl, PERSONAL_AGENT_MODEL: "local-test-model", PERSONAL_AGENT_API_KEY: apiKey },
      {
        write: (text: string) => { writes.push(text); },
        ask: async () => null,
        onInterrupt: () => () => {},
        close: () => {},
        interactive: false,
        hidden: () => {},
      } as never,
    );
    assert.equal(exitCode, 0);
    const output = writes.join("");
    assert.match(output, /answer from a real socket/);
    // Exactly once: a refactor once left the inline reply write in place next to
    // the new budget line, so the answer printed twice. Nothing but a count
    // catches that.
    assert.equal(output.split("answer from a real socket").length - 1, 1, "the reply is printed exactly once");
    assert.equal(output.split("[步骤 ").length - 1, 1, "and so is the budget line");
    assert.match(output, /\[步骤 1\/10 · 工具 0\/32 · prompt \d+B\/512\.0KB · 令牌 11\/131072\(剩131061\)/);
    assert.ok(!output.includes(apiKey), "the key never reaches stdout");
    assert.equal(captured.length, 1);

    const log = await readFile(new SessionStore({ root: fixture2.home }).pathFor("live"), "utf8");
    assert.match(log, /hello there/);
    assert.match(log, /answer from a real socket/);
    assert.ok(!log.includes(apiKey), "the key never reaches the session log");
  });
});
