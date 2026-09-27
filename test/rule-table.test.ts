import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_RULES, filePolicy } from "../src/file-policy.ts";
import { MAX_PRIORITY, RULE_TIERS, decide, effectivePriority } from "../src/rule-table.ts";
import type { Rule } from "../src/rule-table.ts";

function rule(overrides: Partial<Rule> & Pick<Rule, "id" | "decision">): Rule {
  return { tool: "*", tier: RULE_TIERS.DEFAULT, priority: 0, ...overrides };
}

describe("rule table: behaviour is preserved", () => {
  it("reproduces the switch it replaced", () => {
    assert.equal(filePolicy("read_file"), "allow");
    for (const tool of ["edit_file", "patch_file", "create_file", "delete_file", "rename_file", "batch_files"]) {
      assert.equal(filePolicy(tool), "approve", tool);
    }
    assert.equal(filePolicy("no_such_tool"), "deny");
    assert.equal(filePolicy("run_command"), "deny");
  });
});

describe("rule table: tier cannot be inverted", () => {
  it("keeps a lower tier below the next tier even at maximum priority", () => {
    // The clamp exists for exactly this: without it, priority 999999 would
    // promote a workspace rule above an admin one.
    const low = effectivePriority({ tier: RULE_TIERS.WORKSPACE, priority: MAX_PRIORITY });
    const high = effectivePriority({ tier: RULE_TIERS.USER, priority: 0 });
    assert.ok(low < high, `${low} must stay below ${high}`);
  });

  it("holds for every adjacent tier pair", () => {
    const tiers = [RULE_TIERS.DEFAULT, RULE_TIERS.EXTENSION, RULE_TIERS.WORKSPACE, RULE_TIERS.USER, RULE_TIERS.ADMIN];
    for (let i = 0; i + 1 < tiers.length; i += 1) {
      const lower = effectivePriority({ tier: tiers[i]!, priority: MAX_PRIORITY });
      const upper = effectivePriority({ tier: tiers[i + 1]!, priority: 0 });
      assert.ok(lower < upper, `tier ${tiers[i]} must not reach tier ${tiers[i + 1]}`);
    }
  });

  it("clamps a negative or absurd priority instead of trusting it", () => {
    assert.equal(effectivePriority({ tier: RULE_TIERS.USER, priority: -5 }), RULE_TIERS.USER);
    assert.equal(effectivePriority({ tier: RULE_TIERS.USER, priority: 10 ** 9 }), RULE_TIERS.USER + MAX_PRIORITY / 1000);
  });

  it("lets the higher tier win regardless of the order rules are listed", () => {
    const admin = rule({ id: "admin", decision: "allow", tier: RULE_TIERS.ADMIN, priority: 0 });
    const workspace = rule({ id: "ws", decision: "deny", tier: RULE_TIERS.WORKSPACE, priority: MAX_PRIORITY });
    assert.equal(decide([admin, workspace], "t", {}).decision, "allow");
    assert.equal(decide([workspace, admin], "t", {}).decision, "allow", "listing order must not matter");
  });

  it("breaks a tie inside one tier by priority", () => {
    const lo = rule({ id: "lo", decision: "deny", tier: RULE_TIERS.USER, priority: 1 });
    const hi = rule({ id: "hi", decision: "allow", tier: RULE_TIERS.USER, priority: 2 });
    assert.equal(decide([lo, hi], "t", {}).decision, "allow");
  });
});

describe("rule table: failure closes", () => {
  it("denies when nothing matches", () => {
    const result = decide([rule({ id: "x", decision: "allow", tool: "other" })], "t", {});
    assert.equal(result.decision, "deny");
    assert.equal(result.rule, null);
    assert.match(result.reason ?? "", /no rule matched/);
  });

  it("denies on an empty table rather than allowing everything", () => {
    assert.equal(decide([], "anything", {}).decision, "deny");
  });

  it("denies when a predicate throws, even if it would have allowed", () => {
    const broken = rule({
      id: "broken",
      decision: "allow",
      when: () => { throw new Error("boom"); },
    });
    assert.equal(decide([broken], "t", {}).decision, "deny");
  });

  it("requires a predicate to return true, not merely something truthy", () => {
    // A predicate returning a non-boolean must not be read as approval.
    const sloppy = rule({ id: "sloppy", decision: "allow", when: (() => "yes") as unknown as Rule["when"] });
    assert.equal(decide([sloppy], "t", {}).decision, "deny");
  });

  it("does not let a later allow rule rescue an earlier deny", () => {
    const deny = rule({ id: "d", decision: "deny", tier: RULE_TIERS.USER, priority: 100 });
    const allow = rule({ id: "a", decision: "allow", tier: RULE_TIERS.USER, priority: 1 });
    assert.equal(decide([allow, deny], "t", {}).decision, "deny", "first match wins");
  });
});

describe("rule table: matching", () => {
  it("matches a tool by name and by wildcard", () => {
    const named = rule({ id: "n", decision: "allow", tool: "read_file", tier: RULE_TIERS.ADMIN });
    assert.equal(decide([named], "read_file", {}).decision, "allow");
    assert.equal(decide([named], "delete_file", {}).decision, "deny");
    const any = rule({ id: "w", decision: "allow", tool: "*", tier: RULE_TIERS.ADMIN });
    assert.equal(decide([any], "delete_file", {}).decision, "allow");
  });

  it("passes arguments to the predicate", () => {
    const scoped = rule({
      id: "scoped", decision: "allow", tier: RULE_TIERS.ADMIN,
      when: (args) => args.path === "safe.txt",
    });
    assert.equal(decide([scoped], "t", { path: "safe.txt" }).decision, "allow");
    assert.equal(decide([scoped], "t", { path: "other.txt" }).decision, "deny");
  });

  it("reports which rule decided, so a decision can be attributed", () => {
    const result = decide(DEFAULT_RULES, "read_file", {});
    assert.equal(result.rule?.id, "read-file");
  });
});
