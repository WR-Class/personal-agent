/**
 * JSON-RPC 2.0 encode/decode and request pairing for the MCP stdio transport
 * (M4 路 C, 丙-1). Pure strings and promises — no process, no I/O.
 *
 * Two kinds of assertion:
 * - Framing/parse: every refusal branch, because a stdio server that emits
 *   garbage on the protocol channel is a fault to surface, not to swallow.
 * - Pairing: a response resolves exactly the request that asked for it, an
 *   unknown id is reported, an error response rejects, and a dead connection
 *   rejects everything outstanding.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  JSONRPC_VERSION,
  RequestPairing,
  drainMessages,
  encodeMessage,
  parseInbound,
} from "../src/mcp-jsonrpc.ts";

describe("mcp json-rpc encode/frame", () => {
  it("encodes a request as one newline-terminated line", () => {
    const line = encodeMessage({ jsonrpc: JSONRPC_VERSION, id: 1, method: "tools/list", params: { cursor: "x" } });
    assert.ok(line.endsWith("\n"));
    assert.equal(line.indexOf("\n"), line.length - 1, "只有末尾一个换行");
    assert.deepEqual(JSON.parse(line), { jsonrpc: "2.0", id: 1, method: "tools/list", params: { cursor: "x" } });
  });

  it("encodes a notification with no id", () => {
    const line = encodeMessage({ jsonrpc: JSONRPC_VERSION, method: "notifications/initialized" });
    const parsed = JSON.parse(line);
    assert.equal(parsed.id, undefined);
    assert.equal(parsed.method, "notifications/initialized");
  });

  // Inbound lines are RESPONSES (id + result) or NOTIFICATIONS (method only) —
  // an id together with a method is a server-initiated request, which parseInbound
  // refuses, so framing fixtures must use one of the two legal inbound shapes.
  const responseLine = (id: number) => JSON.stringify({ jsonrpc: JSONRPC_VERSION, id, result: {} }) + "\n";

  it("drains complete lines and keeps a partial remainder", () => {
    const a = responseLine(1);
    const b = responseLine(2);
    // Feed one and a half lines: the half must stay in `rest`.
    const half = b.slice(0, 10);
    const { messages, rest } = drainMessages(a + half);
    assert.equal(messages.length, 1);
    assert.equal(rest, half, "半行留在 rest 里，不被解析");
    // Now complete the second line.
    const done = drainMessages(rest + b.slice(10));
    assert.equal(done.messages.length, 1);
    assert.equal(done.rest, "");
  });

  it("skips blank keep-alive lines", () => {
    const { messages, rest } = drainMessages("\n  \n" + responseLine(1));
    assert.equal(messages.length, 1);
    assert.equal(rest, "");
  });
});

describe("mcp json-rpc parse refusals", () => {
  it("refuses non-JSON, non-object, and wrong version", () => {
    assert.throws(() => parseInbound("{bad"), /不是合法 JSON/);
    assert.throws(() => parseInbound("[]"), /必须是一个对象/);
    assert.throws(() => parseInbound(JSON.stringify({ jsonrpc: "1.0", id: 1, result: 1 })), /jsonrpc 版本/);
  });

  it("refuses a server-initiated request (id + method together)", () => {
    assert.throws(
      () => parseInbound(JSON.stringify({ jsonrpc: "2.0", id: 5, method: "sampling/createMessage" })),
      /不支持服务器发起的请求/,
    );
  });

  it("parses a notification", () => {
    const msg = parseInbound(JSON.stringify({ jsonrpc: "2.0", method: "notifications/tools/list_changed" }));
    assert.equal("id" in msg, false);
    assert.equal((msg as { method: string }).method, "notifications/tools/list_changed");
  });

  it("refuses a response missing id, with a non-integer id, or with neither/both result and error", () => {
    assert.throws(() => parseInbound(JSON.stringify({ jsonrpc: "2.0", result: 1 })), /缺少 id/);
    assert.throws(() => parseInbound(JSON.stringify({ jsonrpc: "2.0", id: "x", result: 1 })), /id 必须是安全整数/);
    assert.throws(() => parseInbound(JSON.stringify({ jsonrpc: "2.0", id: 1 })), /恰好有 result 或 error/);
    assert.throws(
      () => parseInbound(JSON.stringify({ jsonrpc: "2.0", id: 1, result: 1, error: { code: -1, message: "x" } })),
      /恰好有 result 或 error/,
    );
  });

  it("parses a result response and an error response", () => {
    const ok = parseInbound(JSON.stringify({ jsonrpc: "2.0", id: 7, result: { tools: [] } }));
    assert.deepEqual((ok as { result: unknown }).result, { tools: [] });
    const err = parseInbound(JSON.stringify({ jsonrpc: "2.0", id: 8, error: { code: -32601, message: "no method" } }));
    assert.deepEqual((err as { error: unknown }).error, { code: -32601, message: "no method" });
  });

  it("refuses a malformed error object", () => {
    assert.throws(() => parseInbound(JSON.stringify({ jsonrpc: "2.0", id: 1, error: {} })), /整数 code/);
    assert.throws(() => parseInbound(JSON.stringify({ jsonrpc: "2.0", id: 1, error: { code: 1 } })), /字符串 message/);
  });
});

describe("mcp request pairing", () => {
  it("gives monotonic ids and resolves the matching response", async () => {
    const pairing = new RequestPairing();
    const a = pairing.next("tools/list", undefined);
    const b = pairing.next("tools/call", { name: "x" });
    assert.equal(a.request.id, 1);
    assert.equal(b.request.id, 2);
    assert.equal(a.request.params, undefined, "无 params 时不写 params 字段");
    assert.deepEqual(b.request.params, { name: "x" });
    assert.equal(pairing.pendingCount, 2);
    // Settle b first, then a — order independence.
    assert.equal(pairing.settle({ jsonrpc: JSONRPC_VERSION, id: 2, result: 42 }), true);
    assert.equal(await b.response, 42);
    assert.equal(pairing.settle({ jsonrpc: JSONRPC_VERSION, id: 1, result: "ok" }), true);
    assert.equal(await a.response, "ok");
    assert.equal(pairing.pendingCount, 0);
  });

  it("reports an unknown id rather than throwing", () => {
    const pairing = new RequestPairing();
    assert.equal(pairing.settle({ jsonrpc: JSONRPC_VERSION, id: 999, result: 1 }), false);
  });

  it("rejects the waiter on an error response", async () => {
    const pairing = new RequestPairing();
    const call = pairing.next("tools/call", {});
    pairing.settle({ jsonrpc: JSONRPC_VERSION, id: call.request.id, error: { code: -32000, message: "boom" } });
    await assert.rejects(() => call.response, /MCP 服务器返回错误 -32000：boom/);
  });

  it("rejects everything outstanding when the connection dies", async () => {
    const pairing = new RequestPairing();
    const a = pairing.next("m", undefined);
    const b = pairing.next("n", undefined);
    pairing.rejectAll("连接已断开");
    await assert.rejects(() => a.response, /连接已断开/);
    await assert.rejects(() => b.response, /连接已断开/);
    assert.equal(pairing.pendingCount, 0);
  });
});
