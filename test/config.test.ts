/**
 * Operator configuration, and the two ways it could have been allowed to
 * escalate itself (D26).
 *
 * Most of these tests are refusals, and each refusal is a shape a configuration
 * file could plausibly arrive with: a `tier` key that would let rules outrank
 * the chosen posture, a `when` key that would have to be turned into a function
 * by evaluating code. Neither is hypothetical — they are the obvious ways to
 * write a more expressive configuration format, and both are the thing D26
 * forbids.
 *
 * The tests that matter most are the ones that would still pass if the module
 * were subtly wrong, so several are paired with a mutation check recorded in the
 * round notes: removing the protection must turn them red.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  configPath,
  configRules,
  loadAgentConfig,
  parseAgentConfig,
  wideningRules,
} from "../src/config.ts";
import { decide, effectivePriority, RULE_TIERS } from "../src/rule-table.ts";
import { SessionStore } from "../src/session-store.ts";
import { findTier } from "../src/tiers.ts";
import { READ_ONLY_TOOLS, WRITE_TOOLS } from "../src/write-tools.ts";
import { createTestFixture } from "./fixtures.ts";
import type { TestFixture } from "./fixtures.ts";

let f: TestFixture;
before(async () => {
  f = await createTestFixture("config");
});

/** Parse from a literal, so most cases need no filesystem at all. */
function parse(value: unknown): ReturnType<typeof parseAgentConfig> {
  return parseAgentConfig(JSON.stringify(value), "config.json");
}

describe("configuration is read only from the agent home", () => {
  it("treats a missing file as no configuration rather than an error", async () => {
    const config = await loadAgentConfig(path.join(f.root, "no-such-home"));
    assert.deepEqual(config.rules, []);
    assert.equal(config.tier, undefined);
    assert.equal(config.source, undefined);
  });

  it("never discovers a configuration file sitting in the workspace", async () => {
    // This is the whole of D26 in one test. gemini-cli reads a workspace settings
    // file and discards it when the folder is untrusted; this project does not
    // read one at all, so there is no trust state to get wrong. A repository that
    // ships a configuration therefore ships nothing.
    const home = path.join(f.root, "home-workspace");
    await mkdir(home, { recursive: true });
    const workspace = path.join(f.root, "workspace-config");
    await mkdir(workspace, { recursive: true });

    const hostile = { rules: [{ tool: "*", decision: "allow" }] };
    // Every place a project-level configuration file would conventionally live.
    for (const name of ["config.json", ".agentrc", "agent.json", ".personal-agent.json"]) {
      await writeFile(path.join(workspace, name), JSON.stringify(hostile), "utf8");
    }
    await mkdir(path.join(workspace, ".agent"), { recursive: true });
    await writeFile(path.join(workspace, ".agent", "config.json"), JSON.stringify(hostile), "utf8");

    const config = await loadAgentConfig(home);
    assert.deepEqual(config.rules, [], "a file inside the workspace was read as configuration");
    assert.equal(config.source, undefined);
  });

  it("reads the agent home file when there is one", async () => {
    const home = path.join(f.root, "home-present");
    await mkdir(home, { recursive: true });
    await writeFile(configPath(home), JSON.stringify({ tier: "read-only", rules: [] }), "utf8");

    const config = await loadAgentConfig(home);
    assert.equal(config.tier, "read-only");
    assert.equal(config.source, configPath(home));
  });
});

describe("a corrupt configuration refuses rather than degrading", () => {
  it("throws on invalid JSON", async () => {
    const home = path.join(f.root, "home-corrupt");
    await mkdir(home, { recursive: true });
    await writeFile(configPath(home), "{not json", "utf8");

    // Not read as empty: this file exists to widen things, and "read as empty"
    // is indistinguishable from "still restricted". Same reasoning as trust.json.
    await assert.rejects(() => loadAgentConfig(home), /not valid JSON/);
  });

  it("throws on a non-object document", () => {
    assert.throws(() => parseAgentConfig("[]", "config.json"), /must be an object/);
    assert.throws(() => parseAgentConfig("3", "config.json"), /must be an object/);
    assert.throws(() => parseAgentConfig("null", "config.json"), /must be an object/);
  });

  it("throws on an unsupported version", () => {
    assert.throws(() => parse({ version: 2, rules: [] }), /version 2 is not supported/);
    assert.throws(() => parse({ version: "1", rules: [] }), /version .* is not supported/);
  });

  it("accepts its own version", () => {
    assert.deepEqual(parse({ version: 1, rules: [] }).rules, []);
  });
});

describe("configuration cannot escalate itself", () => {
  it("refuses a rule that names a tier", () => {
    // The escalation this exists to stop: RULE_TIERS orders ADMIN above USER and
    // a higher tier outranks a lower one whatever its priority says, so a rule
    // that could choose its own tier could outrank the chosen posture and the
    // audit record full-access writes.
    assert.throws(
      () => parse({ rules: [{ tool: "run_command", decision: "allow", tier: 5 }] }),
      /must not set "tier".*cannot outrank the chosen posture/s,
    );
  });

  it("refuses a rule that names a predicate", () => {
    // `Rule.when` is a function. Building one from JSON means evaluating code,
    // which would make the configuration file an execution surface — the same
    // reason crush's bash-script `crushrc` was not adopted.
    assert.throws(
      () => parse({ rules: [{ tool: "run_command", decision: "allow", when: "() => true" }] }),
      /must not set "when".*execution surface/s,
    );
  });

  it("refuses unknown keys instead of ignoring them", () => {
    // A key this project does not understand is usually one the operator believes
    // is doing something. Accepting it silently leaves a configuration that looks
    // stronger than it is.
    assert.throws(() => parse({ rules: [], sandbox: false }), /unknown key "sandbox"/);
    assert.throws(
      () => parse({ rules: [{ tool: "run_command", decision: "allow", patterns: ["git *"] }] }),
      /unknown key "patterns"/,
    );
  });

  it("refuses a decision outside the three the table understands", () => {
    assert.throws(() => parse({ rules: [{ tool: "run_command", decision: "permit" }] }), /one of allow, approve, deny/);
    assert.throws(() => parse({ rules: [{ tool: "run_command" }] }), /needs "decision"/);
    assert.throws(() => parse({ rules: [{ decision: "allow" }] }), /non-empty "tool"/);
    assert.throws(() => parse({ rules: [{ tool: "", decision: "allow" }] }), /non-empty "tool"/);
    assert.throws(() => parse({ rules: "run_command" }), /must be an array/);
  });

  it("refuses a posture name that does not exist", () => {
    // Reported here rather than surfacing later as a confusing mid-run failure.
    assert.throws(() => parse({ tier: "yolo" }), /not a known posture: yolo/);
    assert.throws(() => parse({ tier: 3 }), /must be a string/);
  });

  it("accepts every posture that does exist", () => {
    for (const tier of ["read-only", "ask-before-writing", "workspace-write", "full-access"]) {
      assert.equal(parse({ tier }).tier, tier);
    }
  });

  it("pins every parsed rule to one tier, chosen in code", () => {
    const rules = configRules(parse({
      rules: [
        { tool: "run_command", decision: "deny" },
        { tool: "*", decision: "approve" },
      ],
    }));
    assert.equal(rules.length, 2);
    for (const rule of rules) {
      assert.equal(rule.tier, RULE_TIERS.WORKSPACE);
    }
  });

  it("keeps a configured priority inside its own tier", () => {
    // Priority may order two configured rules against each other, but
    // `effectivePriority` clamps to 0..999, so no configured value can cross into
    // the tier above. Asserted on the arithmetic rather than trusted from a comment.
    const rules = configRules(parse({ rules: [{ tool: "run_command", decision: "deny", priority: 999 }] }));
    assert.equal(rules[0]!.tier, RULE_TIERS.WORKSPACE);
    assert.ok(
      effectivePriority(rules[0]!) < RULE_TIERS.USER,
      "a configured priority reached the USER tier, so configuration could outrank a posture boundary",
    );
    assert.throws(
      () => parse({ rules: [{ tool: "run_command", decision: "deny", priority: 1000 }] }),
      /integer in 0\.\.999/,
    );
    assert.throws(
      () => parse({ rules: [{ tool: "run_command", decision: "deny", priority: 1.5 }] }),
      /integer in 0\.\.999/,
    );
  });

  it("cannot out-prioritise the posture's own boundary", () => {
    // `read-only` pins its deny-every-write rule at USER. Configuration sits a tier
    // below, so no priority it can name reaches it. This is the case that made the
    // tier choice load-bearing rather than cosmetic: within a tier the larger
    // priority wins, so had configuration also been USER, `priority: 999` would
    // have beaten the boundary and quietly re-permitted a write decision.
    const tier = findTier("read-only")!;
    const attempted = configRules(parse({
      rules: [{ tool: "run_command", decision: "allow", priority: 999 }],
    }));
    const match = decide([...attempted, ...tier.rules], "run_command", { command: "rm -rf x" });
    assert.equal(match.decision, "deny", "configuration outranked the read-only boundary");

    // And the tool is absent from the posture anyway, so the registry would refuse
    // it by name before any rule were consulted. Two independent mechanisms, which
    // is the point: absence is not a permission and permission is not absence.
    assert.equal(tier.tools.includes("run_command"), false);
    assert.ok(!WRITE_TOOLS.some((tool) => tier.tools.includes(tool)), "read-only offers a write tool");
  });
});

describe("widening is identified so it can be audited", () => {
  it("flags a configured allow on a tool the posture asked about", () => {
    const tier = findTier("workspace-write")!;
    const config = parse({ rules: [{ tool: "run_command", decision: "allow" }] });
    const widening = wideningRules(config, tier.rules);
    assert.equal(widening.length, 1);
    assert.equal(widening[0]!.tool, "run_command");
  });

  it("does not flag narrowing, or allowing something already allowed", () => {
    const tier = findTier("workspace-write")!;
    // `deny` and `approve` narrow or hold steady; neither stops an ask.
    assert.deepEqual(wideningRules(parse({ rules: [{ tool: "run_command", decision: "deny" }] }), tier.rules), []);
    assert.deepEqual(wideningRules(parse({ rules: [{ tool: "run_command", decision: "approve" }] }), tier.rules), []);
    // Read-only tools are already allowed in every posture that offers them.
    for (const tool of READ_ONLY_TOOLS) {
      assert.deepEqual(
        wideningRules(parse({ rules: [{ tool, decision: "allow" }] }), tier.rules),
        [],
        `${tool} was reported as widening`,
      );
    }
  });

  it("flags a wildcard allow, which widens everything at once", () => {
    const tier = findTier("workspace-write")!;
    assert.equal(wideningRules(parse({ rules: [{ tool: "*", decision: "allow" }] }), tier.rules).length, 1);
  });

  it("does not flag a posture that already allows it", () => {
    // Under full-access nothing is asked about, so a configured allow adds nothing
    // and must not produce a misleading audit line.
    const tier = findTier("full-access")!;
    assert.deepEqual(wideningRules(parse({ rules: [{ tool: "run_command", decision: "allow" }] }), tier.rules), []);
  });
});

describe("the widening audit line survives a round trip", () => {
  it("writes and reads back an 'allowed' audit event", async () => {
    // This test exists because the type checker did not catch the bug it covers.
    // `AuditEvent.decision` is a TypeScript union, but `SessionStore` also
    // validates the same field at runtime when it reads a persisted line back,
    // and the two were separate sources of truth. Widening only the union
    // compiled cleanly, passed every unit test, and then failed on a real run with
    // "audit.decision must be denied or expired". Only running the actual CLI
    // surfaced it, so the round trip is now pinned here.
    const home = path.join(f.root, "home-audit");
    await mkdir(home, { recursive: true });
    const store = new SessionStore({ root: path.join(home, "state") });
    const sessionId = "config-audit";

    const written = await store.appendAudit(sessionId, {
      tool: "run_command",
      decision: "allowed",
      reason: 'configuration allows "run_command" without asking',
      rule: "config:widen",
    });
    assert.equal(written.decision, "allowed");

    // `read`, not `history`: history returns chat messages and filters audit lines
    // out, while `read` returns every persisted record through the parser that
    // carries the runtime guard. That parser is the half the type system does not
    // cover, and the half that actually failed.
    const events = await store.read(sessionId);
    const audit = events.filter((entry) => (entry as { kind?: string }).kind === "audit");
    assert.equal(audit.length, 1, "the audit line did not come back");
    const line = audit[0] as unknown as { decision: string; rule?: string | null; reason: string };
    assert.equal(line.decision, "allowed");
    assert.equal(line.rule, "config:widen", "`rule` vanished on the way back in");
    assert.match(line.reason, /without asking/);
  });
});

describe("configured rules take part in real decisions", () => {
  it("outranks the posture's default but not an ADMIN rule", () => {
    const tier = findTier("workspace-write")!;
    const narrowing = configRules(parse({ rules: [{ tool: "run_command", decision: "deny" }] }));
    assert.equal(decide([...narrowing, ...tier.rules], "run_command", { command: "dir" }).decision, "deny");

    // full-access writes an ADMIN allow-all. A USER rule cannot beat it, which is
    // the ordering that keeps configuration below the recorded operator decision.
    const full = findTier("full-access")!;
    const attempted = configRules(parse({ rules: [{ tool: "run_command", decision: "deny", priority: 999 }] }));
    assert.equal(decide([...attempted, ...full.rules], "run_command", { command: "dir" }).decision, "allow");
  });

  it("lets a later rule in the file win over an earlier one", () => {
    const rules = configRules(parse({
      rules: [
        { tool: "run_command", decision: "deny" },
        { tool: "run_command", decision: "approve" },
      ],
    }));
    // Same tier, so priority decides, and priority rises with position in the file.
    assert.equal(decide(rules, "run_command", { command: "dir" }).decision, "approve");
  });

  it("carries the operator's reason into the decision", () => {
    const rules = configRules(parse({
      rules: [{ tool: "run_command", decision: "deny", reason: "no shells on this machine" }],
    }));
    const match = decide(rules, "run_command", { command: "dir" });
    assert.equal(match.decision, "deny");
    assert.match(String(match.reason ?? ""), /no shells on this machine/);
  });
});
