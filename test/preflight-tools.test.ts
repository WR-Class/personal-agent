/**
 * The live tool-calling probe (D40).
 *
 * A status check structurally cannot see either of the two provider failures
 * that cost real time in this project: a gateway that rejects the request shape
 * and returns 502, and — worse — a gateway that answers HTTP 200 while silently
 * discarding the `tools` array. The second one makes the agent look like it is
 * running while every tool call fails, and the failure message appears nowhere
 * in this codebase, so it sends the operator looking for a bug in their own code.
 *
 * Every test here injects `fetch`, so the verdicts are exercised without a
 * network and without a key.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { probeToolCalling } from "../src/preflight.ts";

const URL = "https://provider.test/v1";
const KEY = "SECRET-KEY-VALUE";

const reply = (body: unknown, status = 200) =>
  async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A response that called the probe's tool, which is the success shape. */
const callsTool = {
  choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "preflight_echo", arguments: '{"value":"ok"}' } }] } }],
};

/** HTTP 200, valid JSON, no tool call — the case this probe exists for. */
const ignoresTool = { choices: [{ message: { role: "assistant", content: "I don't have any tools available." } }] };

describe("live tool-calling probe", () => {
  it("reports success when the provider returns a tool call", async () => {
    const result = await probeToolCalling(URL, "m", KEY, reply(callsTool) as unknown as typeof fetch);
    assert.equal(result.request.status, "ok");
    assert.equal(result.tools.status, "ok");
  });

  it("catches a provider that returns 200 but discards tools", async () => {
    const result = await probeToolCalling(URL, "m", KEY, reply(ignoresTool) as unknown as typeof fetch);
    // The request genuinely succeeded, and the tool capability genuinely failed.
    // Reporting one verdict for both is how this stayed invisible.
    assert.equal(result.request.status, "ok");
    assert.equal(result.tools.status, "fail");
    assert.match(result.tools.detail, /丢弃了 tools/);
  });

  it("quotes what the model said instead of guessing why", async () => {
    const result = await probeToolCalling(URL, "m", KEY, reply(ignoresTool) as unknown as typeof fetch);
    assert.match(result.request.detail, /I don't have any tools available/);
  });

  it("reports an HTTP error with its status", async () => {
    const fetchImpl = (async () => new Response("bad gateway", { status: 502 })) as unknown as typeof fetch;
    const result = await probeToolCalling(URL, "m", KEY, fetchImpl);
    assert.equal(result.request.status, "fail");
    assert.match(result.request.detail, /502/);
  });

  it("declines to judge tools when the request itself failed", async () => {
    const fetchImpl = (async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    const result = await probeToolCalling(URL, "m", KEY, fetchImpl);
    // "We could not measure" must not be reported as "tools work".
    assert.equal(result.tools.status, "fail");
    assert.match(result.tools.detail, /无法判定/);
  });

  it("reports a non-JSON 200 as a failure rather than a pass", async () => {
    const fetchImpl = (async () => new Response("<html>proxy</html>", { status: 200 })) as unknown as typeof fetch;
    const result = await probeToolCalling(URL, "m", KEY, fetchImpl);
    assert.equal(result.request.status, "fail");
    assert.match(result.request.detail, /不是 JSON/);
  });

  it("always sends the model, a tool, and the key", async () => {
    let seen: { url: string; body: any; auth: string | null } = { url: "", body: null, auth: null };
    const fetchImpl = (async (url: unknown, init: RequestInit) => {
      seen = {
        url: String(url),
        body: JSON.parse(String(init.body)),
        auth: new Headers(init.headers).get("authorization"),
      };
      return new Response(JSON.stringify(callsTool), { status: 200 });
    }) as unknown as typeof fetch;
    await probeToolCalling(URL, "the-model", KEY, fetchImpl);
    assert.equal(seen.url, `${URL}/chat/completions`);
    assert.equal(seen.body.model, "the-model");
    assert.equal(seen.body.tools[0].function.name, "preflight_echo");
    assert.equal(seen.auth, `Bearer ${KEY}`);
    // A bound is sent, because this gateway was measured rejecting requests
    // without it — the adapter's own bug, and the probe must not repeat it.
    assert.equal(typeof seen.body.max_tokens, "number");
  });

  it("never puts the key in a reported detail", async () => {
    // A broken proxy can echo the request back in an error page.
    const fetchImpl = (async () => new Response(`upstream failed: ${KEY}`, { status: 502 })) as unknown as typeof fetch;
    const result = await probeToolCalling(URL, "m", KEY, fetchImpl);
    const text = `${result.request.detail}${result.tools.detail}`;
    assert.ok(!text.includes(KEY), "the probe leaked the key into its report");
  });
});
