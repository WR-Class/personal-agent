/**
 * Bridging an MCP server's tools into this project's `Tool` (M4 路 C, 丙-3).
 *
 * Three layers of assertion:
 * - Parse-level: `listMcpTools`/`parseMcpTool` refusal branches, against
 *   hand-built tools/list shapes.
 * - Decision-level: `readOnly` is always false regardless of what the server
 *   claims, `externalSchema` is always set, and `mcpBridgeRule` is `approve`
 *   rather than `allow` and targets the exact registry name.
 * - End-to-end: a real echo MCP server subprocess (same technique as
 *   mcp-client.test.ts), bridged, executed through the real `decide` +
 *   `ToolRegistry` path with a real approval prompt.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { startMcpClient } from "../src/mcp-client.ts";
import {
  listMcpTools,
  mcpBridgeRule,
  mcpToolRegistryName,
  mcpToolToTool,
  type McpToolInfo,
} from "../src/mcp-bridge.ts";
import { ToolRegistry } from "../src/tools.ts";
import { decide } from "../src/rule-table.ts";
import { buildToolEnvironment } from "../src/tool-environment.ts";

const created: string[] = [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

after(async () => {
  // Five real subprocesses are spawned across this file (mcp-client.test.ts only
  // spawns per-test with fewer total), so Windows needs longer than that file's
  // 200ms for every child's file handles on its fixture directory to release
  // before rmSync can remove it; maxRetries/retryDelay alone were not enough,
  // measured as an EPERM on the fixture directory itself.
  await wait(500);
  for (const dir of created) rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

function echoServer(): { file: string; home: string; ws: string } {
  const base = mkdtempSync(path.join(process.cwd(), ".mcp-bridge-fixture-"));
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
    if (msg.method === undefined || msg.id === undefined) continue;
    handle(msg);
  }
});
function send(obj) { process.stdout.write(JSON.stringify(obj) + "\\n"); }
function handle(msg) {
  if (msg.method === "initialize") { send({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: "2025-06-18" } }); return; }
  if (msg.method === "tools/list") {
    send({ jsonrpc: "2.0", id: msg.id, result: { tools: [
      { name: "echo", description: "Echo text back.", inputSchema: { type: "object", properties: { text: { type: "string", pattern: "^.*$" } }, required: ["text"] }, annotations: { readOnlyHint: true } },
      { name: "boom", description: "Always fails.", inputSchema: { type: "object" } },
    ] } });
    return;
  }
  if (msg.method === "tools/call") {
    if (msg.params.name === "boom") { send({ jsonrpc: "2.0", id: msg.id, error: { code: -32000, message: "server-side failure" } }); return; }
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + (msg.params.arguments && msg.params.arguments.text) }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}
`;
  const file = path.join(base, "server.mjs");
  writeFileSync(file, script, "utf8");
  return { file, home, ws };
}

function envFor(home: string, ws: string) {
  return buildToolEnvironment({ workspaceRoot: ws, agentHome: home });
}

describe("mcp-bridge: parsing", () => {
  it("parses a well-formed tools/list entry, description and annotations optional", () => {
    const client = { request: async () => ({ tools: [
      { name: "a", inputSchema: { type: "object" } },
      { name: "b", description: "d", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
    ] }) } as never;
    return listMcpTools(client).then((tools) => {
      assert.equal(tools.length, 2);
      assert.equal(tools[0]?.description, undefined);
      assert.equal(tools[1]?.annotations?.readOnlyHint, true);
    });
  });

  it("refuses a response with no tools array", async () => {
    const client = { request: async () => ({}) } as never;
    await assert.rejects(() => listMcpTools(client), /缺少 tools 数组/);
  });

  it("refuses an entry missing name or inputSchema", async () => {
    const missingName = { request: async () => ({ tools: [{ inputSchema: {} }] }) } as never;
    await assert.rejects(() => listMcpTools(missingName), /缺少非空 name/);
    const missingSchema = { request: async () => ({ tools: [{ name: "x" }] }) } as never;
    await assert.rejects(() => listMcpTools(missingSchema), /缺少对象形式的 inputSchema/);
  });

  it("refuses a non-object entry", async () => {
    const client = { request: async () => ({ tools: ["x"] }) } as never;
    await assert.rejects(() => listMcpTools(client), /不是对象/);
  });
});

describe("mcp-bridge: registry name and rule", () => {
  it("namespaces the registry name by server", () => {
    assert.equal(mcpToolRegistryName("weather", "forecast"), "mcp__weather__forecast");
  });

  it("mcpBridgeRule approves the exact registry name, never allow", () => {
    const rule = mcpBridgeRule("mcp__weather__forecast");
    assert.equal(rule.decision, "approve");
    assert.equal(rule.tool, "mcp__weather__forecast");
    assert.notEqual(rule.tool, "*", "不得用字面通配符规则");
  });
});

describe("mcp-bridge: readOnly is always false regardless of server claims", () => {
  const client = { request: async () => ({ content: [] }) } as never;

  it("readOnlyHint: true does not make the bridged tool readOnly", () => {
    const info: McpToolInfo = { name: "x", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } };
    const tool = mcpToolToTool("s", info, client);
    assert.equal(tool.readOnly, false);
  });

  it("no annotations at all still yields readOnly: false", () => {
    const info: McpToolInfo = { name: "x", inputSchema: { type: "object" } };
    const tool = mcpToolToTool("s", info, client);
    assert.equal(tool.readOnly, false);
  });

  it("externalSchema is always set so the server's own schema is not re-validated by us", () => {
    const info: McpToolInfo = { name: "x", inputSchema: { type: "object", pattern: "not a real object-level key but proves passthrough" } };
    const tool = mcpToolToTool("s", info, client);
    assert.equal(tool.externalSchema, true);
    assert.deepEqual((tool.parameters as Record<string, unknown>).pattern, info.inputSchema.pattern, "server schema passed through verbatim");
  });
});

describe("mcp-bridge: end-to-end over a real subprocess", () => {
  it("lists real tools, then calls one through decide + ToolRegistry with approval", async () => {
    const { file, home, ws } = echoServer();
    const client = startMcpClient({ command: process.execPath, args: [file] }, envFor(home, ws));
    try {
      await client.initialize("personal-agent");
      const infos = await listMcpTools(client);
      assert.deepEqual(infos.map((i) => i.name), ["echo", "boom"]);

      const echoTool = mcpToolToTool("demo", infos[0]!, client);
      const rule = mcpBridgeRule(echoTool.name);
      const registry = new ToolRegistry([echoTool]);

      // Without approval wired up, decide() says approve, but the tool itself must
      // still ask - proving the rule alone does not bypass the prompt.
      const match = decide([rule], echoTool.name, { text: "hi" });
      assert.equal(match.decision, "approve");

      let asked = 0;
      const result = await registry.execute(
        { id: "t1", name: echoTool.name, arguments: JSON.stringify({ text: "hi" }) },
        { workspaceRoot: ws, rules: [rule], approve: async () => { asked += 1; return true; } },
      );
      assert.equal(asked, 1, "the bridged tool prompted for approval itself");
      assert.equal(result.isError, undefined);
      assert.equal(result.content, "echo:hi");
    } finally {
      client.close();
    }
  });

  it("without any rule for it, the bridged tool is denied by the table's own default", async () => {
    const { file, home, ws } = echoServer();
    const client = startMcpClient({ command: process.execPath, args: [file] }, envFor(home, ws));
    try {
      await client.initialize("personal-agent");
      const infos = await listMcpTools(client);
      const echoTool = mcpToolToTool("demo", infos[0]!, client);
      const registry = new ToolRegistry([echoTool]);
      // No rules passed -> DEFAULT_RULES, which has no entry for this MCP tool ->
      // "no rule matched; denied by default" -> and because readOnly is false,
      // the registry enforces that denial.
      const result = await registry.execute(
        { id: "t1", name: echoTool.name, arguments: JSON.stringify({ text: "hi" }) },
        { workspaceRoot: ws },
      );
      assert.equal(result.isError, true);
      assert.match(result.content, /denied by rule|denied by default/);
    } finally {
      client.close();
    }
  });

  it("an operator decline is reported through the tool, not a thrown error", async () => {
    const { file, home, ws } = echoServer();
    const client = startMcpClient({ command: process.execPath, args: [file] }, envFor(home, ws));
    try {
      await client.initialize("personal-agent");
      const infos = await listMcpTools(client);
      const echoTool = mcpToolToTool("demo", infos[0]!, client);
      const rule = mcpBridgeRule(echoTool.name);
      const registry = new ToolRegistry([echoTool]);
      const result = await registry.execute(
        { id: "t1", name: echoTool.name, arguments: JSON.stringify({ text: "hi" }) },
        { workspaceRoot: ws, rules: [rule], approve: async () => false },
      );
      assert.equal(result.isError, true);
      assert.match(result.content, /operator declined/);
    } finally {
      client.close();
    }
  });

  it("a server-side tools/call error becomes an error ToolResult, not a thrown exception", async () => {
    const { file, home, ws } = echoServer();
    const client = startMcpClient({ command: process.execPath, args: [file] }, envFor(home, ws));
    try {
      await client.initialize("personal-agent");
      const infos = await listMcpTools(client);
      const boom = infos.find((i) => i.name === "boom")!;
      const boomTool = mcpToolToTool("demo", boom, client);
      const rule = mcpBridgeRule(boomTool.name);
      const registry = new ToolRegistry([boomTool]);
      // mcpBridgeRule's decision is "approve", not "allow", so the registry never
      // sets preApproved for it (only an "allow" verdict does) — this must go
      // through a real approve() callback, the same as production.
      const result = await registry.execute(
        { id: "t1", name: boomTool.name, arguments: "{}" },
        { workspaceRoot: ws, rules: [rule], approve: async () => true },
      );
      assert.equal(result.isError, true);
      assert.match(result.content, /server-side failure/);
    } finally {
      client.close();
    }
  });

  it("a schema keyword our own validator does not support still passes through unvalidated", async () => {
    const { file, home, ws } = echoServer();
    const client = startMcpClient({ command: process.execPath, args: [file] }, envFor(home, ws));
    try {
      await client.initialize("personal-agent");
      const infos = await listMcpTools(client);
      const echoTool = mcpToolToTool("demo", infos[0]!, client);
      // echo's schema has a `pattern` keyword, which inspectSchema does not
      // recognise. Without externalSchema this call would fail with "unsupported
      // tool schema"; with it, the call reaches the server.
      const rule = mcpBridgeRule(echoTool.name);
      const registry = new ToolRegistry([echoTool]);
      const result = await registry.execute(
        { id: "t1", name: echoTool.name, arguments: JSON.stringify({ text: "pattern-schema-ok" }) },
        { workspaceRoot: ws, rules: [rule], approve: async () => true },
      );
      assert.equal(result.isError, undefined);
      assert.equal(result.content, "echo:pattern-schema-ok");
    } finally {
      client.close();
    }
  });
});
