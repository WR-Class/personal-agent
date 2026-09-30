/**
 * M4 路 C 丙-4, wired end to end through the real CLI entry point (`main`).
 *
 * `mcp-plugin.test.ts` proves `loadMcpPlugins` in isolation; this file proves the
 * thing an operator actually runs: `main([...])` with a `plugin.json` sitting in
 * the agent home ends up able to call the bridged tool through a real model
 * response, and `--tier read-only` refuses to load the plugin at all. `fetch` is
 * mocked (same technique as `phase1.test.ts`'s CLI tests) so this exercises the
 * real adapter, the real tool loop, and the real registry/rule wiring — only the
 * network response is synthetic.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

import { main } from "../src/cli.ts";
import { pluginsDir } from "../src/plugin-manifest.ts";
import { createTestFixture } from "./fixtures.ts";
import type { TerminalIO } from "../src/terminal.ts";

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
    send({ jsonrpc: "2.0", id: msg.id, result: { content: [{ type: "text", text: "echo:" + (msg.params.arguments && msg.params.arguments.text) }] } });
    return;
  }
  send({ jsonrpc: "2.0", id: msg.id, error: { code: -32601, message: "method not found" } });
}
`;

function writeEchoPlugin(home: string): void {
  const root = path.join(pluginsDir(home), "demo");
  const scriptDir = path.join(root, "server");
  mkdirSync(scriptDir, { recursive: true });
  writeFileSync(path.join(scriptDir, "server.mjs"), ECHO_SERVER, "utf8");
  writeFileSync(
    path.join(root, "plugin.json"),
    JSON.stringify({
      name: "demo",
      version: "1.0.0",
      mcpServers: { main: { command: process.execPath, args: ["server/server.mjs"] } },
    }),
    "utf8",
  );
}

function testIo(): { io: TerminalIO; output: string[] } {
  const output: string[] = [];
  return {
    output,
    io: {
      interactive: false,
      async ask() { throw new Error("unexpected prompt"); },
      write(text) { output.push(text); },
      onInterrupt() { return () => {}; },
      close() {},
    },
  };
}

/**
 * Interactive IO feeding a scripted input queue. `--prompt` is deliberately not
 * used for the approval test: `cli.ts` only wires a real `approve` callback (the
 * one `io.ask("批准？> ")` in the non-echo branch) when running interactively,
 * so a non-interactive `main([..., "prompt"])` call can never get past an
 * `approve`-decision tool like the MCP bridge's — it fails with "no approval
 * channel is configured" (found by running this test, not by reading first).
 */
function interactiveIo(inputs: (string | null)[]): { io: TerminalIO; output: string[] } {
  const output: string[] = [];
  return {
    output,
    io: {
      interactive: true,
      async ask() { return inputs.shift() ?? null; },
      write(text) { output.push(text); },
      onInterrupt() { return () => {}; },
      close() {},
    },
  };
}

describe("mcp plugin wiring through the real CLI", () => {
  it("a plugin's bridged tool is registered, rule-governed, and callable through a real model tool_call", async (t) => {
    const fixture = await createTestFixture("mcp-plugin-cli");
    writeEchoPlugin(fixture.home);
    // Interactive: first ask() answers the prompt, second answers the approval
    // gate mcpBridgeRule's "approve" decision raises, third exits the loop.
    const { io, output } = interactiveIo(["call the mcp tool", "是", "/exit"]);

    let call = 0;
    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      call += 1;
      const body = JSON.parse(String(init?.body));
      if (call === 1) {
        // First turn: the model is offered the bridged tool by name and calls it.
        assert.ok(
          body.tools.some((tool: { function: { name: string } }) => tool.function.name === "mcp__demo.main__echo"),
          `expected mcp__demo.main__echo among tools, got ${JSON.stringify(body.tools.map((x: { function: { name: string } }) => x.function.name))}`,
        );
        return new Response(JSON.stringify({
          model: "m",
          choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: "", tool_calls: [
            { id: "c1", type: "function", function: { name: "mcp__demo.main__echo", arguments: '{"text":"hi"}' } },
          ] } }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }));
      }
      // Second turn: the tool result made it back into the transcript sent to the model.
      const toolMessage = body.messages.find((m: { role: string }) => m.role === "tool");
      assert.match(String(toolMessage?.content ?? ""), /echo:hi/);
      return new Response(JSON.stringify({
        model: "m",
        choices: [{ finish_reason: "stop", message: { content: "done" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });

    const code = await main(
      ["--home", fixture.home, "--workspace", fixture.workspaceRoot, "--session", "s"],
      { PERSONAL_AGENT_BASE_URL: "https://example.test/v1", PERSONAL_AGENT_API_KEY: "K", PERSONAL_AGENT_MODEL: "m" },
      io,
    );
    assert.equal(code, 0);
    assert.match(output.join(""), /done/);
  });

  it("--tier read-only never loads the plugin, and the fetch mock never sees the tool", async (t) => {
    const fixture = await createTestFixture("mcp-plugin-cli-readonly");
    writeEchoPlugin(fixture.home);
    const { io, output } = testIo();

    t.mock.method(globalThis, "fetch", async (_url: unknown, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      assert.ok(
        !body.tools?.some((tool: { function: { name: string } }) => tool.function.name.startsWith("mcp__")),
        "no mcp__ tool should be offered under read-only",
      );
      return new Response(JSON.stringify({
        model: "m",
        choices: [{ finish_reason: "stop", message: { content: "no tools needed" } }],
        usage: { prompt_tokens: 1, completion_tokens: 1 },
      }));
    });

    const code = await main(
      ["--home", fixture.home, "--workspace", fixture.workspaceRoot, "--session", "s", "--tier", "read-only", "hello"],
      { PERSONAL_AGENT_BASE_URL: "https://example.test/v1", PERSONAL_AGENT_API_KEY: "K", PERSONAL_AGENT_MODEL: "m" },
      io,
    );
    assert.equal(code, 0);
    assert.match(output.join(""), /no tools needed/);
  });
});
