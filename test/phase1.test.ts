import { readFile } from "node:fs/promises";
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { SessionStore, migrateEvent, CURRENT_EVENT_VERSION } from "../src/session-store.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { createEchoAdapter } from "../src/echo-adapter.ts";
import { createOpenAIChatAdapter, CHAT_RESPONSE_MAX_BYTES } from "../src/openai-adapter.ts";
import { main, parseArgs } from "../src/cli.ts";
import type { TerminalIO } from "../src/terminal.ts";
import { createTestFixture } from "./fixtures.ts";

let root = "";
let home = "";
let workspaceRoot = "";

before(async () => {
  const fixture = await createTestFixture("phase1");
  root = fixture.storeRoot;
  home = fixture.home;
  workspaceRoot = fixture.workspaceRoot;
});

function makeRuntime(sessionId: string) {
  return new AgentRuntime({
    adapter: createEchoAdapter(), store: new SessionStore({ root }), sessionId, home, workspaceRoot,
  });
}

describe("session store", () => {
  it("writes one versioned JSON line per event", async () => {
    const store = new SessionStore({ root });
    await store.create("v1");
    await store.appendMessage("v1", { role: "user", content: "hi" });
    await store.appendUsage("v1", { inputTokens: 2, outputTokens: 3 });

    const lines = (await readFile(store.pathFor("v1"), "utf8")).trim().split("\n");
    assert.equal(lines.length, 3);
    for (const line of lines) assert.equal(JSON.parse(line).v, CURRENT_EVENT_VERSION);
  });

  it("reloads history and totals after reopening the store", async () => {
    const runtime = makeRuntime("reload");
    await runtime.send("first");
    await runtime.send("second");

    const reopened = makeRuntime("reload");
    const history = await reopened.history();
    assert.deepEqual(
      history.map((message) => message.role),
      ["user", "assistant", "user", "assistant"],
    );
    assert.equal(history[0]!.content, "first");
    assert.equal(history[1]!.content, "echo: first");
    assert.ok((await reopened.totals()).outputTokens > 0);
  });

  it("returns an empty history for an unknown session", async () => {
    assert.deepEqual(await new SessionStore({ root }).history("missing"), []);
  });

  it("rejects path traversal in session ids", () => {
    assert.throws(() => new SessionStore({ root }).pathFor("../escape"), /invalid session id/);
  });

  it("upgrades an older unversioned line instead of failing", () => {
    const migrated = migrateEvent({ kind: "message", at: "t", message: { role: "user", content: "old" } });
    assert.ok(migrated, "an unversioned known kind must migrate, not be skipped");
    assert.equal(migrated.v, CURRENT_EVENT_VERSION);
    assert.equal(migrated.kind, "message");
  });

  it("refuses an event from a newer schema", () => {
    assert.throws(() => migrateEvent({ v: CURRENT_EVENT_VERSION + 1, kind: "message" }), /newer than supported/);
  });

  it("rejects an unknown event kind that is not marked ignorable", () => {
    assert.throws(() => migrateEvent({ v: 1, kind: "nonsense" }), /unknown event kind: nonsense/);
  });
});

describe("runtime", () => {
  it("persists the user turn before the answer and returns both", async () => {
    const runtime = makeRuntime("loop");
    const result = await runtime.send("  hello  ");
    assert.equal(result.reply.content, "echo: hello");
    assert.equal(result.model, "echo-1");
    assert.deepEqual(
      result.history.map((message) => message.role),
      ["user", "assistant"],
    );
  });

  it("prepends the system prompt without persisting it", async () => {
    const runtime = new AgentRuntime({
      adapter: createEchoAdapter(),
      store: new SessionStore({ root }),
      sessionId: "system",
      home,
      workspaceRoot,
      systemPrompt: "be brief",
    });
    const result = await runtime.send("hi");
    assert.equal(result.history[0]!.role, "system");
    assert.deepEqual(
      (await runtime.history()).map((message) => message.role),
      ["user", "assistant"],
    );
  });

  it("rejects an empty prompt", async () => {
    await assert.rejects(() => makeRuntime("empty").send("   "), /empty input/);
  });
});

describe("openai adapter", () => {
  it("posts an OpenAI-shaped body and parses the reply", async () => {
    let seenUrl = "";
    let seenBody: unknown;
    const adapter = createOpenAIChatAdapter({
      baseUrl: "https://example.test/v1/",
      apiKey: "secret",
      model: "test-model",
      fetchImpl: async (url, init) => {
        seenUrl = String(url);
        seenBody = JSON.parse(String(init?.body));
        return new Response(
          JSON.stringify({
            model: "test-model",
            choices: [{ message: { content: "pong" } }],
            usage: { prompt_tokens: 7, completion_tokens: 2 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    const response = await adapter.chat({ messages: [{ role: "user", content: "ping" }] });
    assert.equal(seenUrl, "https://example.test/v1/chat/completions");
    assert.deepEqual(seenBody, { model: "test-model", messages: [{ role: "user", content: "ping" }] });
    assert.equal(response.content, "pong");
    assert.deepEqual(response.usage, { inputTokens: 7, outputTokens: 2 });
  });

  it("throws with the status code on an HTTP error", async () => {
    const adapter = createOpenAIChatAdapter({
      baseUrl: "https://example.test/v1",
      apiKey: "secret",
      model: "m",
      fetchImpl: async () => new Response("bad key", { status: 401 }),
    });
    await assert.rejects(
      () => adapter.chat({ messages: [{ role: "user", content: "x" }] }),
      /HTTP 401/,
    );
  });

  it("refuses an oversized body even when content-length understates it", async () => {
    const body = JSON.stringify({ choices: [{ message: { content: "x".repeat(CHAT_RESPONSE_MAX_BYTES) } }] });
    const adapter = createOpenAIChatAdapter({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: async () => new Response(body, {
        status: 200,
        headers: { "content-type": "application/json", "content-length": "5" },
      }),
    });
    await assert.rejects(
      () => adapter.chat({ messages: [{ role: "user", content: "x" }] }),
      /exceeds the 1048576-byte limit/,
    );
  });

  it("accepts a body exactly at the byte ceiling", async () => {
    const wrap = (content: string) => JSON.stringify({ choices: [{ message: { content } }] });
    const fill = CHAT_RESPONSE_MAX_BYTES - Buffer.byteLength(wrap(""), "utf8");
    const raw = wrap("x".repeat(fill));
    assert.equal(Buffer.byteLength(raw, "utf8"), CHAT_RESPONSE_MAX_BYTES);
    const adapter = createOpenAIChatAdapter({
      baseUrl: "https://example.test/v1",
      apiKey: "k",
      model: "m",
      fetchImpl: async () => new Response(raw, { status: 200, headers: { "content-type": "application/json" } }),
    });
    const response = await adapter.chat({ messages: [{ role: "user", content: "x" }] });
    assert.equal(response.content.length, fill);
  });
});

describe("cli", () => {
  it("parses flags, session id and prompt", () => {
    const options = parseArgs(["--session", "s1", "--totals", "hello", "world"], {});
    assert.equal(options.session, "s1");
    assert.equal(options.prompt, "hello world");
    assert.equal(options.showTotals, true);
    assert.equal(options.list, false);
  });

  it("main refuses missing or partial configuration and uses Echo only explicitly", async t => {
    const f = await createTestFixture("cli-selection");
    const output: string[] = [];
    const io: TerminalIO = { interactive: false, async ask() { throw new Error("unexpected prompt"); },
      write(text) { output.push(text); }, onInterrupt() { return () => {}; }, close() {} };
    const fetchMock = t.mock.method(globalThis, "fetch", async () => { throw new Error("unexpected network request"); });
    const args = ["--home", f.home, "--workspace", f.workspaceRoot, "--session", "s", "hello"];
    for (const env of [{}, { PERSONAL_AGENT_MODEL: "m" }]) {
      await assert.rejects(() => main(args, env, io), /配置/);
      assert.deepEqual(await new SessionStore({ root: f.home }).history("s"), []);
    }
    assert.equal(await main(["--echo", ...args], { PERSONAL_AGENT_MODEL: "m" }, io), 0);
    assert.match(output.join(""), /echo: hello/);
    assert.equal(fetchMock.mock.callCount(), 0);
    assert.deepEqual((await new SessionStore({ root: f.home }).history("s")).map(m => m.role), ["user", "assistant"]);
  });

  it("main uses complete provider environment through the actual HTTP adapter", async t => {
    const f = await createTestFixture("cli-provider");
    const output: string[] = [];
    const io: TerminalIO = { interactive: false, async ask() { throw new Error("unexpected prompt"); },
      write(text) { output.push(text); }, onInterrupt() { return () => {}; }, close() {} };
    const fetchMock = t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
      assert.equal(String(url), "https://example.test/v1/chat/completions");
      assert.equal(new Headers(init?.headers).get("authorization"), "Bearer SYNTHETIC_KEY");
      const body = JSON.parse(String(init?.body));
      assert.equal(body.model, "m");
      assert.equal(body.messages.at(-1).content, "hello");
      return new Response(JSON.stringify({ model: "m", choices: [{ finish_reason: "stop", message: { content: "provider reply" } }],
        usage: { prompt_tokens: 2, completion_tokens: 3 } }));
    });
    assert.equal(await main(["--home", f.home, "--workspace", f.workspaceRoot, "--session", "s", "--totals", "hello"], {
      PERSONAL_AGENT_BASE_URL: "https://example.test/v1", PERSONAL_AGENT_API_KEY: "SYNTHETIC_KEY", PERSONAL_AGENT_MODEL: "m",
    }, io), 0);
    assert.equal(fetchMock.mock.callCount(), 1);
    assert.match(output.join(""), /provider reply/);
    assert.match(output.join(""), /adapter=openai-chat model=m/);
    assert.equal((await new SessionStore({ root: f.home }).history("s")).at(-1)?.content, "provider reply");
  });
});
