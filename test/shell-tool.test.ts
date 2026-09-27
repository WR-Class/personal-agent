/**
 * The permission tier must actually gate `run_command` (D46).
 *
 * These tests exist because the first version of the shell tool ignored the tier
 * completely: under `workspace-write`, whose rule for `run_command` is `approve`,
 * a live run executed `echo hi > test.txt` and the file appeared. Every unit test
 * still passed, because nothing asserted the relationship between the rule table
 * and what the tool does with its answer.
 *
 * So the property under test is not "the rule table returns approve" — the table
 * is already tested — but "the tool acts on that answer". A tool that is offered,
 * allowed by nothing, and asks for nothing is the failure this file is here to
 * catch.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createRunCommandTool } from "../src/tools.ts";
import { RULE_TIERS } from "../src/rule-table.ts";
import type { Rule } from "../src/rule-table.ts";
import type { Tool, ToolContext } from "../src/tools.ts";
import { buildToolEnvironment } from "../src/tool-environment.ts";
import { DEFAULT_RULES } from "../src/file-policy.ts";

const rules: readonly Rule[] = DEFAULT_RULES;

function context(overrides: Partial<ToolContext>): ToolContext {
  return {
    workspaceRoot: process.cwd(),
    protectedStateRoots: [],
    rules,
    ...overrides,
  };
}

async function run(tool: Tool, args: Record<string, unknown>, ctx: ToolContext) {
  return await tool.execute(args, ctx);
}

describe("run_command respects the tier", () => {
  it("refuses to run with no approval channel, rather than running anyway", async () => {
    // The `workspace-write` posture: the rule is `approve` and there is nobody to
    // ask, so the correct outcome is refusal. The measured wrong outcome was the
    // command executing and the write landing on disk.
    const tool = createRunCommandTool();
    const result = await run(tool, { command: "echo should-not-run" }, context({}));
    assert.equal(result.isError, true, "a command ran without approval");
    assert.match(String(result.content), /no approval channel/);
  });

  it("does not run when the operator declines", async () => {
    const tool = createRunCommandTool();
    const result = await run(tool, { command: "echo should-not-run" }, context({ approve: async () => false }));
    assert.equal(result.isError, true);
    assert.match(String(result.content), /declined/);
  });

  it("runs when pre-approved, without asking", async () => {
    // `full-access`: the table already allowed this call, so asking would
    // contradict the posture chosen. The `approve` callback is deliberately
    // absent to prove nothing consults it.
    const tool = createRunCommandTool();
    const environment = buildToolEnvironment({ workspaceRoot: process.cwd(), agentHome: process.cwd() });
    const result = await run(tool, { command: "node --version" }, context({
      preApproved: true,
      toolEnvironment: environment,
    }));
    assert.notEqual(result.isError, true, String(result.content));
    assert.match(String(result.content), /v\d+\./, `expected a version, got: ${result.content}`);
    assert.match(String(result.content), /exit code: 0/);
  });

  it("still requires an environment, even when pre-approved", async () => {
    // Pre-approval is about permission, not about the environment. Falling back
    // to `process.env` here would run the command with the operator's HOME while
    // every other tool used the agent's.
    const tool = createRunCommandTool();
    const result = await run(tool, { command: "echo hi" }, context({ preApproved: true }));
    assert.equal(result.isError, true);
    assert.match(String(result.content), /environment/i);
  });

  it("reports a failing command as output, not as a tool failure", async () => {
    // A non-zero exit is information the model needs in order to correct itself.
    // Treating it as an error of this tool would hide the message that says what
    // was wrong.
    const tool = createRunCommandTool();
    const environment = buildToolEnvironment({ workspaceRoot: process.cwd(), agentHome: process.cwd() });
    const result = await run(tool, { command: "node --definitely-not-a-flag" }, context({
      preApproved: true,
      toolEnvironment: environment,
    }));
    assert.notEqual(result.isError, true, "a non-zero exit was reported as a tool error");
    assert.match(String(result.content), /exit code: [1-9]/);
  });

  it("rejects an empty command", async () => {
    const tool = createRunCommandTool();
    const result = await run(tool, { command: "" }, context({ preApproved: true }));
    assert.equal(result.isError, true);
  });
});

describe("run_command is classified as a tool that needs approval", () => {
  it("is not in the read-only list", async () => {
    const { READ_ONLY_TOOLS, WRITE_TOOLS } = await import("../src/write-tools.ts");
    assert.ok(!READ_ONLY_TOOLS.includes("run_command"), "run_command must not be called read-only");
    assert.ok(WRITE_TOOLS.includes("run_command"), "run_command must need approval");
  });

  it("is absent from the read-only tier, not merely denied in it", async () => {
    const { findTier } = await import("../src/tiers.ts");
    const tier = findTier("read-only")!;
    assert.ok(!tier.tools.includes("run_command"), "the read-only tier must not offer a shell");
  });

  it("is offered by both tiers that allow writing", async () => {
    const { findTier } = await import("../src/tiers.ts");
    for (const name of ["workspace-write", "full-access"]) {
      assert.ok(findTier(name)!.tools.includes("run_command"), `${name} must offer run_command`);
    }
  });

  it("is allowed outright only by the tier that removes the prompt", async () => {
    const { findTier } = await import("../src/tiers.ts");
    const { decide } = await import("../src/rule-table.ts");
    assert.equal(decide(findTier("workspace-write")!.rules, "run_command", {}).decision, "approve");
    assert.equal(decide(findTier("full-access")!.rules, "run_command", {}).decision, "allow");
    // The read-only tier denies as a backstop; the tool is absent anyway, and both
    // mechanisms agreeing is what keeps a present tool from being unusable.
    assert.equal(decide(findTier("read-only")!.rules, "run_command", {}).decision, "deny");
  });

  it("keeps the rule table's approval set and the tiers' write set in agreement", async () => {
    // Two mechanisms answering one question is what produced an earlier defect:
    // a tool offered by a tier and denied by the table. Checking the whole list
    // rather than the one name means a tool added to either side is caught.
    const { WRITE_TOOLS } = await import("../src/write-tools.ts");
    const { filePolicy } = await import("../src/file-policy.ts");
    for (const tool of WRITE_TOOLS) {
      assert.notEqual(filePolicy(tool, rules), "deny", `${tool} is a write tool the table denies`);
    }
  });
});

describe("the rule table's allow reaches the tool", () => {
  it("does not mark a call pre-approved when the rule says approve", async () => {
    // Exercised through the registry, because the wiring is what was missing:
    // the table's answer used to be consulted only for `deny`, so `allow` had no
    // effect and every write still asked.
    const { ToolRegistry } = await import("../src/tools.ts");
    const environment = buildToolEnvironment({ workspaceRoot: process.cwd(), agentHome: process.cwd() });
    let asked = 0;
    const registry = new ToolRegistry(
      [createRunCommandTool()],
      ["run_command"],
    );
    const result = await registry.execute(
      { id: "call-1", name: "run_command", arguments: JSON.stringify({ command: "echo x" }) },
      context({
        toolEnvironment: environment,
        approve: async () => {
          asked += 1;
          return true;
        },
      }),
    );
    // `DEFAULT_RULES` gives run_command `approve`, so it MUST ask.
    assert.equal(asked, 1, "an approving rule did not reach the approval channel");
    assert.notEqual(result.isError, true, String(result.content));
  });

  it("does not ask when the rule says allow", async () => {
    const { ToolRegistry } = await import("../src/tools.ts");
    const environment = buildToolEnvironment({ workspaceRoot: process.cwd(), agentHome: process.cwd() });
    let asked = 0;
    const registry = new ToolRegistry([createRunCommandTool()], ["run_command"]);
    const result = await registry.execute(
      { id: "call-1", name: "run_command", arguments: JSON.stringify({ command: "echo x" }) },
      context({
        toolEnvironment: environment,
        rules: [{ id: "test.allow-all", tool: "*", decision: "allow", tier: RULE_TIERS.ADMIN, priority: 0 }],
        approve: async () => {
          asked += 1;
          return true;
        },
      }),
    );
    assert.equal(asked, 0, "an allowing rule still prompted");
    assert.notEqual(result.isError, true, String(result.content));
  });
});
