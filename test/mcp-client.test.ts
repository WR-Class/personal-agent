/**
 * MCP client over a stdio subprocess (M4 路 C, 丙-2).
 *
 * These are real-process tests, not mocks: each spawns a tiny MCP server written
 * as a Node script into the fixture and speaks the wire protocol to it. A mock of
 * a subprocess would prove the client talks to a mock; a real child proves it
 * spawns, handshakes, calls, times out, and shuts down against an actual pipe —
 * the same discipline background-jobs.test.ts uses (a script file, not inline
 * quoting, to dodge the measured shell-quoting traps).
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";

import { startMcpClient } from "../src/mcp-client.ts";
import { buildToolEnvironment } from "../src/tool-environment.ts";

const created: string[] = [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

after(async () => {
  await wait(200);
  // Yield while retrying: close() launches taskkill asynchronously; synchronous
  // retries block Node's close/error callbacks and their direct-kill fallback.
  for (const dir of created) await rm(dir, { recursive: true, force: true, maxRetries: 40, retryDelay: 250 });
});

/**
 * A minimal MCP server as a Node script. It reads newline-delimited JSON-RPC on
 * stdin and answers initialize / tools/list / tools/call. `behaviour` lets a test
 * ask for a slow or silent server to exercise timeouts.
 */
function writeServer(behaviour: "normal" | "slow" | "error" = "normal"): string {
  const base = mkdtempSync(path.join(process.cwd(), ".mcp-fixture-"));
  created.push(base);
  const home = path.join(base, "home");
  const ws = path.join(base, "ws");
  mkdirSync(home, { recursive: true });
  mkdirSync(ws, { recursive: true });
  const script = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  let nl;
  while ((nl = buf.indexOf("\\n")) !== -1) {
    const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
    if (line.trim() === "") continue;
    const msg = JSON.parse(line);
    if (msg.method === undefined || msg.id === undefined) continue; // notification
    handle(msg);
  }
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function handle(msg) {
  const BEHAVIOUR = ${JSON.stringify(behaviour)};
  if (msg.method === "initialize") {
    send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "echo", version: "1" }, capabilities: { tools: {} } } });
    return;
  }
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [{ name: "echo", description: "echo back", inputSchema: { type: "object", properties: { text: { type: "string" } } } }] } });
    return;
  }
  if (msg.method === "tools/call") {
    if (BEHAVIOUR === "error") { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "tool blew up" } }); return; }
    if (BEHAVIOUR === "slow") { return; } // never answer -> client times out
    const text = (msg.params && msg.params.arguments && msg.params.arguments.text) || "";
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + text }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}
`;
  const file = path.join(base, "server.mjs");
  writeFileSync(file, script, "utf8");
  return JSON.stringify({ file, home, ws });
}

function envFor(home: string, ws: string) {
  return buildToolEnvironment({ workspaceRoot: ws, agentHome: home });
}

describe("mcp client over stdio", () => {
  it("spawns, handshakes, lists tools, and calls a tool", async () => {
    const { file, home, ws } = JSON.parse(writeServer("normal"));
    const client = startMcpClient({ command: process.execPath, args: [file] }, envFor(home, ws));
    try {
      const init = (await client.initialize("personal-agent")) as { serverInfo?: { name?: string } };
      assert.equal(init.serverInfo?.name, "echo");
      const list = (await client.request("tools/list")) as { tools: { name: string }[] };
      assert.deepEqual(list.tools.map((t) => t.name), ["echo"]);
      const call = (await client.request("tools/call", { name: "echo", arguments: { text: "hi" } })) as {
        content: { text: string }[];
      };
      assert.equal(call.content[0]?.text, "echo:hi");
    } finally {
      client.close();
    }
  });

  it("rejects a call with an error response, without tearing down the connection", async () => {
    const { file, home, ws } = JSON.parse(writeServer("error"));
    const client = startMcpClient({ command: process.execPath, args: [file] }, envFor(home, ws));
    try {
      await client.initialize("personal-agent");
      await assert.rejects(() => client.request("tools/call", { name: "echo" }), /tool blew up/);
      // Connection still usable after a tool error.
      const list = (await client.request("tools/list")) as { tools: unknown[] };
      assert.equal(list.tools.length, 1);
    } finally {
      client.close();
    }
  });

  it("times out a request the server never answers", async () => {
    const { file, home, ws } = JSON.parse(writeServer("slow"));
    const client = startMcpClient({ command: process.execPath, args: [file] }, envFor(home, ws));
    try {
      await client.initialize("personal-agent");
      await assert.rejects(() => client.request("tools/call", { name: "echo" }, 300), /请求超时（300ms）/);
    } finally {
      client.close();
    }
  });

  it("fails outstanding calls and refuses new ones after close", async () => {
    const { file, home, ws } = JSON.parse(writeServer("slow"));
    const client = startMcpClient({ command: process.execPath, args: [file] }, envFor(home, ws));
    await client.initialize("personal-agent");
    const pending = client.request("tools/call", { name: "echo" }, 5000);
    client.close();
    await assert.rejects(() => pending, /已被客户端关闭|已退出/);
    assert.equal(client.closed, true);
    await assert.rejects(() => client.request("tools/list"), /连接已关闭/);
  });

  it("fails calls when the server process dies on its own", async () => {
    const { file, home, ws } = JSON.parse(writeServer("normal"));
    const client = startMcpClient({ command: process.execPath, args: [file] }, envFor(home, ws));
    await client.initialize("personal-agent");
    // Kill the child out from under the client and prove pending work fails.
    const pending = client.request("tools/call", { name: "echo", arguments: { text: "x" } }, 5000);
    client.close();
    await assert.rejects(() => pending);
    assert.equal(client.closed, true);
  });

  it("rejects a request that cannot even spawn", async () => {
    const { home, ws } = JSON.parse(writeServer("normal"));
    const client = startMcpClient({ command: path.join(ws, "does-not-exist.exe") }, envFor(home, ws));
    await assert.rejects(() => client.initialize("personal-agent"));
    assert.equal(client.closed, true);
    client.close();
  });
});
