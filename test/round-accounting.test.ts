/**
 * A round that ends by throwing still pays its accounting (D162).
 *
 * Cancelling a run used to print one error line and nothing else. The reply never
 * arrived, so every line after the `send` call was skipped — including the budget line,
 * which is where the elapsed time and the tool-call count live. The operator therefore
 * could not see what the abandoned round had already spent, and that is precisely the
 * number a cancellation destroys and the number that decides whether trying again is
 * reasonable.
 *
 * The fix has two halves and either alone is useless, so both are checked here: the
 * runtime records the round's numbers **before** it throws, and the CLI prints them from
 * a place both endings reach.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AgentRuntime } from "../src/runtime.ts";
import { SessionStore } from "../src/session-store.ts";
import { ToolRegistry, createReadFileTool } from "../src/tools.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { createTestFixture } from "./fixtures.ts";
import { startTestServer } from "./server-fixture.ts";
import { main } from "../src/cli.ts";
import type { TerminalIO } from "../src/terminal.ts";

const fixture = await createTestFixture("round-accounting");
await writeFile(join(fixture.workspaceRoot, "a.txt"), "read me\n", "utf8");

const servers: { close(): Promise<void> }[] = [];
after(async () => { for (const server of servers) await server.close(); });

let created = 0;

describe("a round that ends by throwing", () => {
  it("⚠️ still hands its budget to the caller, with the counters it had reached", async () => {
    const sessionId = `throwing-${created++}`;
    const store = new SessionStore({ root: fixture.storeRoot });
    await store.create(sessionId);
    // One scripted step, so the round really runs and then the adapter runs out of
    // replies. The throw therefore comes from inside the loop, which is the shape a
    // cancellation has — not a failure before the round started.
    const adapter = createScriptedAdapter({
      steps: [{ toolCalls: [{ id: "c1", name: "read_file", arguments: JSON.stringify({ path: "a.txt" }) }] }] as never,
      model: "m",
    });
    const agent = new AgentRuntime({
      adapter,
      store,
      sessionId,
      home: fixture.home,
      workspaceRoot: fixture.workspaceRoot,
      tools: new ToolRegistry([createReadFileTool()], ["read_file"]),
      systemPrompt: "You are a concise assistant.",
      approve: async () => true,
    });

    await assert.rejects(() => agent.send("开始"), /ran out of steps/);

    const budget = agent.lastBudget();
    assert.ok(budget !== undefined, "the round reported no budget at all after throwing");
    assert.equal(budget.stepsUsed, 1, "the step that really ran is counted, not zeroed");
    assert.equal(budget.toolCallsUsed, 1, "and so is the call that really ran");
    assert.ok((budget.filesWrittenLimit ?? 0) > 0, "the limit is reported too, so the usage has a scale");
  });

  it("⚠️ records it on the returning ending too, not only on the throwing one", async () => {
    // The CLI prints the budget from a place both endings reach, so a successful round
    // that does not record its own cost prints no cost line at all. The first version of
    // this change had exactly that bug: only the catch set the field, and the whole line
    // vanished from every successful run.
    const sessionId = `returning-${created++}`;
    const store = new SessionStore({ root: fixture.storeRoot });
    await store.create(sessionId);
    const agent = new AgentRuntime({
      adapter: createScriptedAdapter({ steps: [{ content: "done" }] as never, model: "m" }),
      store,
      sessionId,
      home: fixture.home,
      workspaceRoot: fixture.workspaceRoot,
      tools: new ToolRegistry([createReadFileTool()], ["read_file"]),
      systemPrompt: "You are a concise assistant.",
      approve: async () => true,
    });

    const result = await agent.send("开始");
    assert.deepEqual(
      agent.lastBudget(),
      result.budget,
      "the round's own budget and the one handed to the caller must be the same object",
    );
  });

  it("reports nothing before the first round, rather than a zeroed budget", async () => {
    // `undefined` and "a round that spent nothing" are different facts, and the CLI
    // prints a line for one of them and not the other.
    const agent = new AgentRuntime({
      adapter: createScriptedAdapter({ steps: [] as never, model: "m" }),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: `untouched-${created++}`,
      home: fixture.home,
      workspaceRoot: fixture.workspaceRoot,
      tools: new ToolRegistry([createReadFileTool()], ["read_file"]),
      systemPrompt: "You are a concise assistant.",
      approve: async () => true,
    });
    assert.equal(agent.lastBudget(), undefined);
  });
});

describe("the CLI after a round that threw", () => {
  it("⚠️ prints the budget line, so a failed round is not silent about what it cost", async () => {
    // A provider that refuses every request. The round throws before any reply exists,
    // which is the same ending a cancellation produces.
    const server = await startTestServer((_request, response) => {
      response.writeHead(502, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: "upstream refused" } }));
    });
    servers.push(server);

    const output: string[] = [];
    const io = {
      write: (text: string) => { output.push(text); },
      ask: async () => null,
      onInterrupt: () => () => {},
      close: () => {},
      interactive: false,
      hidden: () => {},
    } as unknown as TerminalIO;

    await assert.rejects(() => main(
      ["--home", fixture.home, "--workspace", fixture.workspaceRoot, "--session", "cli-threw", "hello"],
      {
        PERSONAL_AGENT_BASE_URL: `http://127.0.0.1:${server.port}/v1`,
        PERSONAL_AGENT_MODEL: "m",
        PERSONAL_AGENT_API_KEY: "k",
      },
      io,
    ));

    const text = output.join("");
    // The elapsed time lives in this one line. Before D162 the whole line was skipped
    // on this path, so this assertion is the difference between the two behaviours.
    assert.match(text, /用时/, "the budget line did not print for a round that threw");
    // The limit side reads `不限` when the budget is unbounded, so this matches the
    // separator rather than a digit.
    assert.match(text, /步骤 \d+\//, "and it carries the counters, not just the clock");
  });
});
