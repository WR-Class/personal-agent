import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TIER, TIERS, findTier, resolveTier } from "../src/tiers.ts";
import { APPROVAL_TOOLS, DEFAULT_RULES } from "../src/file-policy.ts";
import { READ_ONLY_TOOLS, WRITE_TOOLS } from "../src/write-tools.ts";
import { RULE_TIERS, decide } from "../src/rule-table.ts";
import type { Rule } from "../src/rule-table.ts";
import { ToolRegistry, createReadFileTool, createEditFileTool } from "../src/tools.ts";
import { SessionStore } from "../src/session-store.ts";
import { createTestFixture } from "./fixtures.ts";
import type { ToolContext } from "../src/tools.ts";
import type { ToolCall } from "../src/types.ts";

let fixture: Awaited<ReturnType<typeof createTestFixture>>;

before(async () => {
  fixture = await createTestFixture("tiers");
});

function call(name: string, args: Record<string, unknown> = {}, id = `call_${name}`): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

describe("tiers: naming and resolution", () => {
  it("offers the four designed postures", () => {
    assert.deepEqual(TIERS.map((t) => t.name), ["read-only", "ask-before-writing", "workspace-write", "full-access"]);
  });

  it("has a middle tier that differs from the default in what it asks", () => {
    // A tier that decides exactly what another one decides is not a posture, it
    // is a synonym — and it would leave an operator unable to tell which of the
    // two they had chosen. This asserts the difference exists rather than
    // assuming the rules above produce one.
    const middle = findTier("ask-before-writing")!;
    const standard = findTier("workspace-write")!;
    const sameDecisions = (a: readonly Rule[], b: readonly Rule[]) =>
      a.length === b.length &&
      a.every((rule) => b.some((other) => other.tool === rule.tool && other.decision === rule.decision));
    assert.equal(
      sameDecisions(middle.rules, standard.rules),
      false,
      "ask-before-writing decides exactly what workspace-write decides, so choosing between them means nothing",
    );
    // Whichever way they differ, neither may become more permissive on writes:
    // that is what would turn a convenience tier into a silent escalation. Checked
    // with arguments that are not a recognised read, which is the case that must
    // fall back to asking rather than to running.
    for (const tool of APPROVAL_TOOLS) {
      assert.equal(
        decide(middle.rules, tool, {}).decision,
        "approve",
        `${tool} must still ask in the middle tier when nothing marks it as a read`,
      );
    }
    // The one intentional exception, stated as such. `dir` rather than `git
    // status`: git is off the read-only whitelist because repository config can
    // run code (see test/middle-tier.test.ts), so it now asks like everything else.
    assert.equal(decide(middle.rules, "run_command", { command: "dir" }).decision, "allow");
    assert.equal(decide(middle.rules, "run_command", { command: "rm -rf build" }).decision, "approve");
  });

  it("defaults to the safe tier when nothing was chosen", () => {
    assert.equal(resolveTier(undefined).name, DEFAULT_TIER);
    assert.equal(resolveTier("").name, DEFAULT_TIER);
    assert.equal(findTier(DEFAULT_TIER)?.removesBoundary, undefined);
  });

  it("refuses an unknown name instead of guessing a posture", () => {
    // Falling back here would let a typo quietly change the posture, and falling
    // back to the permissive tier would hand out access on a misspelling.
    assert.throws(() => resolveTier("workspace-writ"), /unknown permission tier: workspace-writ/);
    assert.throws(
      () => resolveTier("yolo"),
      /known: read-only, ask-before-writing, workspace-write, full-access/,
    );
  });

  it("marks only the permissive tier as removing a boundary", () => {
    assert.equal(findTier("full-access")?.removesBoundary, true);
    assert.equal(findTier("read-only")?.removesBoundary, undefined);
    assert.equal(findTier("workspace-write")?.removesBoundary, undefined);
  });
});

describe("tiers: what each one decides", () => {
  /**
   * A tool that is listed but then denied hands the model something it can never
   * successfully call, and the refusal it gets ("this tool is not available")
   * reads as a policy boundary, so it stops trying rather than looking for the
   * real problem. Measured live: an inspection tool was listed in one tier while
   * the rule table allowed only `read_file`, and the model was refused with
   * "unknown tool" for doing exactly what the system prompt told it to.
   *
   * Two mechanisms answer the same question — presence in the list is absence,
   * the rule table is denial — so this asserts that they agree.
   */
  it("never lists a tool its own rules deny", () => {
    for (const tier of TIERS) {
      for (const tool of tier.tools) {
        assert.notEqual(
          decide(tier.rules, tool, {}).decision, "deny",
          `${tier.name} lists ${tool} but its rules deny it`,
        );
      }
    }
  });

  it("offers every read-only tool in every tier", () => {
    // No tier exists to remove the ability to read; they exist to grant writing.
    for (const tier of TIERS) {
      for (const tool of READ_ONLY_TOOLS) {
        assert.ok(tier.tools.includes(tool), `${tier.name} must offer ${tool}`);
        assert.notEqual(decide(tier.rules, tool, {}).decision, "deny", `${tier.name} must allow ${tool}`);
      }
    }
  });

  it("read-only denies writing and never offers the write tools", () => {
    const tier = findTier("read-only")!;
    assert.equal(decide(tier.rules, "edit_file", {}).decision, "deny");
    assert.equal(decide(tier.rules, "create_file", {}).decision, "deny");
    assert.equal(decide(tier.rules, "delete_file", {}).decision, "deny");
    assert.equal(decide(tier.rules, "read_file", {}).decision, "allow");
    // Asserted as the property rather than as a fixed list, so adding another
    // read-only tool does not require rewriting this test: what matters is that
    // nothing here writes. The list is derived from the same source the tiers
    // use, so a tool cannot be read-only here and writing there.
    assert.deepEqual([...tier.tools], [...READ_ONLY_TOOLS]);
    for (const name of tier.tools) {
      assert.equal(
        WRITE_TOOLS.includes(name),
        false,
        `${name} is offered by read-only but is classified as writing`,
      );
    }
    const writing = ["edit_file", "patch_file", "create_file", "delete_file", "rename_file", "batch_files"];
    for (const name of writing) {
      assert.equal(tier.tools.includes(name), false, `read-only must not offer ${name}`);
      assert.equal(decide(tier.rules, name, {}).decision, "deny");
    }
  });

  it("read-only refuses even an unknown tool", () => {
    assert.equal(decide(findTier("read-only")!.rules, "run_command", {}).decision, "deny");
  });

  it("workspace-write keeps the built-in posture", () => {
    const tier = findTier("workspace-write")!;
    assert.equal(decide(tier.rules, "read_file", {}).decision, "allow");
    assert.equal(decide(tier.rules, "edit_file", {}).decision, "approve");
    assert.equal(decide(tier.rules, "unknown_tool", {}).decision, "deny");
    assert.deepEqual([...tier.rules], [...DEFAULT_RULES]);
  });

  it("full-access allows without asking, and says so in the rule id", () => {
    const tier = findTier("full-access")!;
    const result = decide(tier.rules, "edit_file", {});
    assert.equal(result.decision, "allow");
    assert.equal(result.rule?.id, "full-access.allow-all");
  });

  it("keeps a hard floor even in the permissive tier", () => {
    // A high tier must not be able to reach the invariants. They are not rules,
    // so they cannot be outranked: the capability set and path confinement still
    // speak, and the permissive rule simply cannot express them.
    const tier = findTier("full-access")!;
    const canExpress = tier.rules.some((r) => /path|capab|confin/i.test(r.id));
    assert.equal(canExpress, false, "a tier must not be able to name an invariant as a rule");
  });
});

describe("tiers: a tier cannot widen the capability set", () => {
  it("keeps an absent tool absent regardless of what any rule says", async () => {
    // full-access allows everything by rule, but the session does not offer the
    // tool, so it stays absent. The capability set runs before the table.
    const registry = new ToolRegistry([createReadFileTool(), createEditFileTool()], ["read_file"]);
    const context: ToolContext = {
      workspaceRoot: fixture.workspaceRoot,
      protectedRoots: [],
      readPaths: new Set<string>(),
      rules: findTier("full-access")!.rules,
    } as unknown as ToolContext;
    const result = await registry.execute(call("edit_file", { path: "a.txt", content: "x" }), context);
    assert.equal(result.isError, true);
    assert.match(result.content, /not available in this session/);
  });
});

describe("audit: a refusal names the rule that made it", () => {
  it("records the rule id alongside the reason", async () => {
    const store = new SessionStore({ root: fixture.storeRoot });
    await store.create("audit-rule");
    const event = await store.appendAudit("audit-rule", {
      tool: "edit_file", decision: "denied", reason: "read-only tier", rule: "read-only.deny-writes",
    });
    assert.equal(event.rule, "read-only.deny-writes");
  });

  it("reads the rule back intact, because the validator rebuilds the record", async () => {
    const store = new SessionStore({ root: fixture.storeRoot });
    await store.create("audit-rule-roundtrip");
    await store.appendAudit("audit-rule-roundtrip", {
      tool: "edit_file", decision: "denied", reason: "no rule matched", rule: null,
    });
    const { events } = await store.inspect("audit-rule-roundtrip");
    const audits = events.filter((e) => e.kind === "audit");
    assert.equal(audits.length, 1);
    // null is meaningful: the table decided, and no rule matched.
    assert.equal((audits[0] as { rule?: string | null }).rule, null);
  });

  it("still parses an older line that has no rule field", async () => {
    const store = new SessionStore({ root: fixture.storeRoot });
    await store.create("audit-legacy");
    await store.appendAudit("audit-legacy", { tool: "edit_file", decision: "denied", reason: "older line" });
    const { events } = await store.inspect("audit-legacy");
    const audit = events.find((e) => e.kind === "audit") as { rule?: string | null } | undefined;
    assert.ok(audit);
    assert.equal(audit.rule, undefined, "absent stays absent, distinct from a null rule");
  });
});

describe("rule table: tier prefixes are the documented ones", () => {
  it("keeps the five tiers in the recorded order", () => {
    assert.deepEqual(
      [RULE_TIERS.DEFAULT, RULE_TIERS.EXTENSION, RULE_TIERS.WORKSPACE, RULE_TIERS.USER, RULE_TIERS.ADMIN],
      [1, 2, 3, 4, 5],
    );
  });
});
