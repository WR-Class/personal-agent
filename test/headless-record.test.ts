/**
 * A headless run records its own task state (D163).
 *
 * The decision this pins lives in the rule table and is unit-tested one layer down, in
 * `task-state-writer.test.ts`. What that test cannot see is whether the command line
 * hands the rules down at all — an entry point that dropped them would fail exactly the
 * way the defect did, with the unit test still green. So this drives the real entry
 * point and asserts on the **durable record**, not on printed output: a printed line can
 * be produced by a layer that recorded nothing.
 *
 * ⚠️ The configuration is the whole point: **no approval channel**. A one-shot run with
 * the default approval mode attaches no approver, which is the situation the defect
 * appeared in. A run with an approver attached would have passed before the change too,
 * and so would prove nothing about it.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { closeAllServers, startTestServer } from "./server-fixture.ts";
import type { TestServer } from "./server-fixture.ts";
import { createTestFixture } from "./fixtures.ts";
import { main } from "../src/cli.ts";
import { SessionStore } from "../src/session-store.ts";
import type { TerminalIO } from "../src/terminal.ts";

const fixture = await createTestFixture("headless-record");
await writeFile(join(fixture.workspaceRoot, "notes.txt"), "plain workspace text\n", "utf8");

const servers: TestServer[] = [];
after(async () => { await closeAllServers(servers); });

/**
 * A provider that asks for one tool call, then answers plainly so the round can finish.
 *
 * Deliberately local and free: this is a wiring question, and a real provider would make
 * it slow, nondeterministic and paid for. The one layer a mock cannot reach — whether a
 * real model actually makes the call — is measured separately, by hand.
 */
async function serveToolCall(name: string, args: string) {
  let seen = 0;
  const server = await startTestServer((_request, response) => {
    seen += 1;
    const first = seen === 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      id: "chatcmpl-1",
      object: "chat.completion",
      model: "m",
      choices: [{
        index: 0,
        finish_reason: first ? "tool_calls" : "stop",
        message: first
          ? { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name, arguments: args } }] }
          : { role: "assistant", content: "记好了" },
      }],
      usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    }));
  });
  servers.push(server);
  return `http://127.0.0.1:${server.port}/v1`;
}

function silentIO(): { io: TerminalIO; output: string[] } {
  const output: string[] = [];
  const io = {
    write: (text: string) => { output.push(text); },
    ask: async () => null,
    onInterrupt: () => () => {},
    close: () => {},
    interactive: false,
    hidden: () => {},
  } as unknown as TerminalIO;
  return { io, output };
}

const STATE = { state: "读一下 notes.txt", steps: [{ text: "读 notes.txt", claim: { kind: "no-write" } }] };

describe("a one-shot run with no approval channel", () => {
  it("⚠️ records the task state the model asked for, and the store is where it lands", async () => {
    const baseUrl = await serveToolCall("update_task_state", JSON.stringify(STATE));
    const { io, output } = silentIO();

    const code = await main(
      ["--home", fixture.home, "--workspace", fixture.workspaceRoot, "--session", "records-it", "读一下 notes.txt"],
      { PERSONAL_AGENT_BASE_URL: baseUrl, PERSONAL_AGENT_MODEL: "m", PERSONAL_AGENT_API_KEY: "k" },
      io,
    );
    assert.equal(code, 0, output.join(""));

    const store = new SessionStore({ root: fixture.home });
    const recorded = await store.taskState("records-it");
    assert.equal(recorded?.state, STATE.state, "the run's own record reached the store");
    assert.deepEqual(recorded?.steps.map((step) => step.text), ["读 notes.txt"]);

    // And the failure this change removed must be absent. A run can look successful for
    // a reason other than the change, so the negative is asserted too rather than assumed.
    const log = JSON.stringify(await store.read("records-it"));
    assert.ok(!log.includes("no approval channel"), `the old refusal is still reachable: ${log.slice(0, 400)}`);
    assert.ok(!log.includes("no approval channel is configured"));
  });

  it("still refuses a file write, because that one is the operator's to approve", async () => {
    // The boundary the change must not have moved. Without an approval channel a file
    // write is refused; the exemption covers the agent's own record and nothing else.
    const baseUrl = await serveToolCall("create_file", JSON.stringify({ path: "notes2.txt", content: "hi" }));
    const { io, output } = silentIO();

    await main(
      ["--home", fixture.home, "--workspace", fixture.workspaceRoot, "--session", "refuses-write", "写一个文件"],
      { PERSONAL_AGENT_BASE_URL: baseUrl, PERSONAL_AGENT_MODEL: "m", PERSONAL_AGENT_API_KEY: "k" },
      io,
    );

    const store = new SessionStore({ root: fixture.home });
    const log = JSON.stringify(await store.read("refuses-write"));
    assert.match(log, /no approval channel is configured/, "a file write still needs a channel");
    assert.ok(!(await store.taskState("refuses-write")), "and nothing recorded itself on the way past");
  });
});
