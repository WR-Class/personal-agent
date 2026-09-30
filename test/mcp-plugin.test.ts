/**
 * Runtime wiring for MCP plugins (M4 路 C, 丙-4): discovery + spawn + bridge, end
 * to end over real subprocesses. Every test writes a real `plugin.json` and a
 * real server script into a fixture agent home, then calls `loadMcpPlugins`
 * exactly as `cli.ts` will.
 */
import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";

import { loadMcpPlugins } from "../src/mcp-plugin.ts";
import { pluginsDir } from "../src/plugin-manifest.ts";
import { buildToolEnvironment } from "../src/tool-environment.ts";
import { ToolRegistry } from "../src/tools.ts";
import { decide } from "../src/rule-table.ts";

const created: string[] = [];
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

after(async () => {
  await wait(500);
  for (const dir of created) rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 150 });
});

const ECHO_SERVER = `
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
      { name: "echo", description: "Echo text back.", inputSchema: { type: "object", properties: { text: { type: "string" } } } },
    ] } });
    return;
  }
  if (msg.method === "tools/call") {
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + (msg.params.arguments && msg.params.arguments.text) + " cwd=" + process.cwd() }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}
`;

function fixture(): { home: string; ws: string } {
  const base = mkdtempSync(path.join(process.cwd(), ".mcp-plugin-fixture-"));
  created.push(base);
  const home = path.join(base, "home");
  const ws = path.join(base, "ws");
  mkdirSync(home, { recursive: true });
  mkdirSync(ws, { recursive: true });
  return { home, ws };
}

/** Write one plugin with the echo server script and a manifest declaring it. */
function writeEchoPlugin(home: string, pluginName: string, extraManifest: Record<string, unknown> = {}): string {
  const root = path.join(pluginsDir(home), pluginName);
  mkdirSync(root, { recursive: true });
  const scriptDir = path.join(root, "server");
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(path.join(scriptDir, "server.mjs"), ECHO_SERVER, "utf8");
  writeFileSync(
    path.join(root, "plugin.json"),
    JSON.stringify({
      name: pluginName,
      version: "1.0.0",
      mcpServers: { main: { command: process.execPath, args: ["server/server.mjs"] } },
      ...extraManifest,
    }),
    "utf8",
  );
  return root;
}

describe("mcp-plugin: loadMcpPlugins", () => {
  it("returns the empty result when there is no plugins directory", async () => {
    const { home, ws } = fixture();
    const result = await loadMcpPlugins(home, buildToolEnvironment({ workspaceRoot: ws, agentHome: home }));
    assert.deepEqual(result.tools, []);
    assert.deepEqual(result.rules, []);
    assert.deepEqual(result.errors, []);
    result.close(); // must not throw on an empty result
  });

  it("returns empty when a plugin exists but declares no mcpServers", async () => {
    const { home, ws } = fixture();
    const root = path.join(pluginsDir(home), "quiet");
    mkdirSync(root, { recursive: true });
    writeFileSync(path.join(root, "plugin.json"), JSON.stringify({ name: "quiet", version: "1.0.0" }), "utf8");
    const result = await loadMcpPlugins(home, buildToolEnvironment({ workspaceRoot: ws, agentHome: home }));
    assert.deepEqual(result.tools, []);
    result.close();
  });

  it("spawns a declared server, bridges its tool, and the tool actually works end to end", async () => {
    const { home, ws } = fixture();
    writeEchoPlugin(home, "demo");
    const result = await loadMcpPlugins(home, buildToolEnvironment({ workspaceRoot: ws, agentHome: home }));
    try {
      assert.equal(result.errors.length, 0);
      assert.equal(result.tools.length, 1);
      const tool = result.tools[0]!;
      assert.equal(tool.name, "mcp__demo.main__echo");
      assert.equal(tool.readOnly, false);

      // The generated rule actually governs the tool through the real registry.
      const registry = new ToolRegistry(result.tools);
      const match = decide(result.rules, tool.name, { text: "x" });
      assert.equal(match.decision, "approve");

      const call = await registry.execute(
        { id: "t1", name: tool.name, arguments: JSON.stringify({ text: "hi" }) },
        { workspaceRoot: ws, rules: result.rules, approve: async () => true },
      );
      assert.equal(call.isError, undefined);
      assert.match(call.content, /^echo:hi cwd=/);
    } finally {
      result.close();
    }
  });

  it("honours a declared cwd for the spawned server", async () => {
    const { home, ws } = fixture();
    // args is relative to whatever cwd ends up in effect, so once cwd narrows to
    // the "server" subdirectory the script is just "server.mjs", not
    // "server/server.mjs" (which is how writeEchoPlugin's own declaration writes
    // it, since that one leaves cwd at the plugin root default).
    writeEchoPlugin(home, "demo", { mcpServers: { main: { command: process.execPath, args: ["server.mjs"], cwd: "server" } } });
    const result = await loadMcpPlugins(home, buildToolEnvironment({ workspaceRoot: ws, agentHome: home }));
    try {
      assert.equal(result.errors.length, 0, JSON.stringify(result.errors));
      const tool = result.tools[0]!;
      const call = await registryCall(result, tool);
      const expectedCwd = path.join(pluginsDir(home), "demo", "server");
      assert.match(call.content, new RegExp(`cwd=${escapeRegExp(expectedCwd)}`));
    } finally {
      result.close();
    }
  });

  it("one server failing to start does not block another plugin's tools, and is reported in errors", async () => {
    const { home, ws } = fixture();
    writeEchoPlugin(home, "good");
    const brokenRoot = path.join(pluginsDir(home), "broken");
    mkdirSync(brokenRoot, { recursive: true });
    writeFileSync(
      path.join(brokenRoot, "plugin.json"),
      JSON.stringify({ name: "broken", version: "1.0.0", mcpServers: { main: { command: path.join(ws, "does-not-exist.exe") } } }),
      "utf8",
    );
    const result = await loadMcpPlugins(home, buildToolEnvironment({ workspaceRoot: ws, agentHome: home }));
    try {
      assert.equal(result.tools.length, 1, "good plugin's tool still loaded");
      assert.equal(result.tools[0]?.name, "mcp__good.main__echo");
      assert.equal(result.errors.length, 1);
      assert.equal(result.errors[0]?.pluginName, "broken");
      assert.equal(result.errors[0]?.serverName, "main");
      assert.ok(result.errors[0]?.message.length > 0);
    } finally {
      result.close();
    }
  });

  it("close() stops every spawned server, even across multiple plugins", async () => {
    const { home, ws } = fixture();
    writeEchoPlugin(home, "one");
    writeEchoPlugin(home, "two");
    const result = await loadMcpPlugins(home, buildToolEnvironment({ workspaceRoot: ws, agentHome: home }));
    assert.equal(result.tools.length, 2);
    result.close();
    // After close, calling either tool must fail rather than hang or silently
    // succeed against a process that no longer exists.
    const registry = new ToolRegistry(result.tools);
    const failed = await registry.execute(
      { id: "t1", name: result.tools[0]!.name, arguments: "{}" },
      { workspaceRoot: ws, rules: result.rules, approve: async () => true },
    );
    assert.equal(failed.isError, true);
  });
});

async function registryCall(result: { tools: readonly { name: string }[]; rules: readonly unknown[] }, tool: { name: string }) {
  const registry = new ToolRegistry(result.tools as never);
  return registry.execute(
    { id: "t1", name: tool.name, arguments: JSON.stringify({ text: "hi" }) },
    { workspaceRoot: process.cwd(), rules: result.rules as never, approve: async () => true },
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
