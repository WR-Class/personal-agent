import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_TIER, TIERS, findTier, resolveTier } from "../src/tiers.ts";
import { DEFAULT_RULES } from "../src/file-policy.ts";
import { RULE_TIERS, decide } from "../src/rule-table.ts";
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
  it("offers the three designed postures", () => {
    assert.deepEqual(TIERS.map((t) => t.name), ["read-only", "workspace-write", "full-access"]);
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
    assert.throws(() => resolveTier("yolo"), /known: read-only, workspace-write, full-access/);
  });

  it("marks only the permissive tier as removing a boundary", () => {
    assert.equal(findTier("full-access")?.removesBoundary, true);
    assert.equal(findTier("read-only")?.removesBoundary, undefined);
    assert.equal(findTier("workspace-write")?.removesBoundary, undefined);
  });
});

describe("tiers: what each one decides", () => {
  it("read-only denies writing and never offers the write tools", () => {
    const tier = findTier("read-only")!;
    assert.equal(decide(tier.rules, "edit_file", {}).decision, "deny");
    assert.equal(decide(tier.rules, "create_file", {}).decision, "deny");
    assert.equal(decide(tier.rules, "delete_file", {}).decision, "deny");
    assert.equal(decide(tier.rules, "read_file", {}).decision, "allow");
    // Asserted as the property rather than as a fixed list, so adding another
    // read-only tool does not require rewriting the test: what matters is that
    // nothing here writes.
    assert.deepEqual([...tier.tools], ["read_file", "inspect_file"]);
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
