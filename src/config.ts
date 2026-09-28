/**
 * Operator configuration (D26).
 *
 * The rule table and the posture were both constants in the source, which meant
 * the only way to change them was to change the program. This module adds the
 * missing direction — an operator can state a default posture and add rules —
 * without adding the thing D26 exists to forbid: configuration that widens its
 * own reach.
 *
 * **Only the agent home is ever read.** gemini-cli loads a workspace settings
 * file and then discards it unless the folder is trusted
 * (`settings.ts:262`, `const safeWorkspace = isTrusted ? workspace : {}`);
 * this project does not load it at all. Gating on trust still depends on the
 * trust state being right, whereas not reading depends on nothing. So there is
 * deliberately no search for `.agentrc`, `agent.json`, or any similar file in
 * the workspace, and cloning a repository cannot ship a configuration.
 *
 * Two shapes of self-escalation are refused by structure rather than by check:
 *
 * - **The rule tier is never a configuration field.** `RULE_TIERS` orders
 *   ADMIN above USER, and a higher tier outranks a lower one whatever its
 *   priority says. Rules parsed here are pinned to USER in code, so a
 *   configuration cannot place itself above the posture that was chosen, and
 *   cannot outrank the audit record `full-access` writes.
 * - **A predicate is never a configuration field.** `Rule.when` is a function,
 *   and the only way to build one from JSON is `eval` or `new Function`, which
 *   would make the configuration file a code-execution surface. Rules here match
 *   a tool name and nothing else. The cost is real and stated: configuration
 *   cannot express "allow only `git status`", only "allow `run_command`".
 *
 * A corrupt file throws rather than being read as empty, following the decision
 * already made for `trust.json`: configuration exists to widen things, and
 * "read as empty" is indistinguishable from "still restricted", which is the
 * wrong answer to give an operator who believes they widened it.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import type { Decision, Rule } from "./rule-table.ts";
import { decide, RULE_TIERS } from "./rule-table.ts";
import { findTier } from "./tiers.ts";

export interface ConfigRule {
  /** Tool name, or `*` for every tool. */
  readonly tool: string;
  readonly decision: Decision;
  /** Optional operator-facing note, recorded in the audit trail. */
  readonly reason?: string;
  /**
   * Ordering within the USER tier, 0..999. It cannot cross a tier boundary:
   * `effectivePriority` clamps it, and ADMIN still outranks USER whatever this
   * says. Omit it and rules are ordered by their position in the file.
   */
  readonly priority?: number;
}

export interface AgentConfig {
  /** Posture name, if the configuration states one. Validated against `TIERS`. */
  readonly tier?: string;
  readonly rules: readonly ConfigRule[];
  /** Where it came from, or `undefined` when there is no configuration file. */
  readonly source?: string;
}

const CONFIG_VERSION = 1;
const DECISIONS: readonly Decision[] = ["allow", "approve", "deny"];

export function configPath(agentHome: string): string {
  return path.join(agentHome, "config.json");
}

/**
 * Load the operator configuration from the agent home.
 *
 * A missing file is normal and yields an empty configuration. Anything else that
 * goes wrong is an error, because the file's whole purpose is to change what the
 * agent is allowed to do and a silently-ignored change is worse than a refusal.
 */
export async function loadAgentConfig(agentHome: string): Promise<AgentConfig> {
  const file = configPath(agentHome);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { rules: [] };
    throw new Error(`config file could not be read: ${file}: ${(error as Error).message}`);
  }
  return parseAgentConfig(text, file);
}

/**
 * Parse and validate configuration text.
 *
 * Unknown keys are rejected rather than ignored. A key this project does not
 * understand is most often a key the operator believes is doing something, and
 * accepting it silently would leave them with a configuration that looks
 * stronger than it is.
 */
export function parseAgentConfig(text: string, file: string): AgentConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`config file is not valid JSON: ${file}: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`config file must be an object: ${file}`);
  }
  const raw = parsed as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (!["version", "tier", "rules"].includes(key)) {
      throw new Error(`config file has an unknown key "${key}": ${file} (known: version, tier, rules)`);
    }
  }

  const version = raw.version;
  if (version !== undefined && version !== CONFIG_VERSION) {
    throw new Error(`config file version ${String(version)} is not supported: ${file} (this build reads version ${CONFIG_VERSION})`);
  }

  let tier: string | undefined;
  if (raw.tier !== undefined) {
    if (typeof raw.tier !== "string") throw new Error(`config "tier" must be a string: ${file}`);
    // Validated against the real list here rather than at use, so a typo is
    // reported as a configuration error instead of surfacing later as a
    // confusing failure halfway through a run.
    if (!findTier(raw.tier)) {
      throw new Error(`config "tier" is not a known posture: ${raw.tier}: ${file}`);
    }
    tier = raw.tier;
  }

  const rules = parseRules(raw.rules, file);
  return { ...(tier === undefined ? {} : { tier }), rules, source: file };
}

function parseRules(value: unknown, file: string): readonly ConfigRule[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new Error(`config "rules" must be an array: ${file}`);
  return value.map((entry, index) => parseRule(entry, index, file));
}

function parseRule(entry: unknown, index: number, file: string): ConfigRule {
  const where = `config rules[${index}]`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`${where} must be an object: ${file}`);
  }
  const raw = entry as Record<string, unknown>;

  // These two rejections are the point of the module, so they get their own
  // messages rather than falling into the generic unknown-key one.
  if ("tier" in raw) {
    throw new Error(
      `${where} must not set "tier": rule tier is fixed in code so configuration cannot outrank the chosen posture: ${file}`,
    );
  }
  if ("when" in raw) {
    throw new Error(
      `${where} must not set "when": a predicate would have to be built from JSON by evaluating code, which would make this file an execution surface: ${file}`,
    );
  }
  for (const key of Object.keys(raw)) {
    if (!["tool", "decision", "reason", "priority"].includes(key)) {
      throw new Error(`${where} has an unknown key "${key}": ${file} (known: tool, decision, reason, priority)`);
    }
  }

  if (typeof raw.tool !== "string" || raw.tool === "") {
    throw new Error(`${where} needs a non-empty "tool": ${file}`);
  }
  if (typeof raw.decision !== "string" || !DECISIONS.includes(raw.decision as Decision)) {
    throw new Error(
      `${where} needs "decision" to be one of ${DECISIONS.join(", ")}: ${file} (got ${JSON.stringify(raw.decision)})`,
    );
  }
  if (raw.reason !== undefined && typeof raw.reason !== "string") {
    throw new Error(`${where} needs "reason" to be a string: ${file}`);
  }
  if (raw.priority !== undefined) {
    // Priority within the USER tier is allowed, because ordering two configured
    // rules against each other is the operator's business. It still cannot cross
    // a tier boundary: `effectivePriority` clamps to 0..999.
    if (typeof raw.priority !== "number" || !Number.isInteger(raw.priority) || raw.priority < 0 || raw.priority > 999) {
      throw new Error(`${where} needs "priority" to be an integer in 0..999: ${file}`);
    }
  }

  return {
    tool: raw.tool,
    decision: raw.decision as Decision,
    ...(typeof raw.reason === "string" ? { reason: raw.reason } : {}),
    ...(typeof raw.priority === "number" ? { priority: raw.priority } : {}),
  };
}

/**
 * Turn validated configuration into rule-table entries.
 *
 * Every rule is pinned to one tier here, in code, and there is no parameter that
 * would let a caller choose otherwise. That is what makes the rejection of a
 * `"tier"` key above meaningful rather than decorative.
 *
 * The tier is WORKSPACE, and the name is unfortunate enough to be worth a
 * warning: **this has nothing to do with reading configuration from the
 * workspace, which this module never does.** It is chosen for where it sits in
 * `RULE_TIERS`, which is the only thing that matters:
 *
 * - below USER, where `read-only` pins its deny-every-write boundary, so a
 *   configuration cannot out-prioritise the posture that was chosen and quietly
 *   re-permit a write decision;
 * - below ADMIN, where `full-access` records its audited allow-all, so a
 *   configuration cannot outrank a decision the operator made explicitly;
 * - level with the rules the writing postures leave at WORKSPACE, so a
 *   configuration *can* adjust those — narrowing freely, and widening only with
 *   an audit line from `wideningRules`.
 *
 * A configuration that could beat its own posture's boundary would be the exact
 * self-escalation D26 forbids, and priority alone cannot express that: within a
 * tier the larger priority wins, so the separation has to be a tier.
 */
export function configRules(config: AgentConfig): Rule[] {
  return config.rules.map((rule, index) => ({
    id: `config:${rule.tool}:${index}`,
    tool: rule.tool,
    decision: rule.decision,
    tier: RULE_TIERS.WORKSPACE,
    // An explicit priority is honoured; otherwise position in the file decides, so
    // that a later rule wins over an earlier one — the ordering a reader of a
    // list expects. Either way the value stays inside its own tier.
    priority: rule.priority ?? 100 + index,
    ...(rule.reason === undefined ? {} : { reason: rule.reason }),
  }));
}

/**
 * Which configured rules widen what the chosen posture already allowed.
 *
 * Removing a boundary has to be a recorded decision rather than something that
 * happens because a file said so (D26/D32). A configured `allow` on something the
 * posture would have asked about is exactly that: the operator stops being asked.
 * This returns them so the caller can write an audit line naming each one, the
 * same way `--tier full-access` is recorded.
 *
 * It asks `decide` rather than inspecting rule shapes, because matching is that
 * function's job and it already handles wildcards, tier order and predicates. A
 * first version of this built a set of tool names from the posture's allow rules
 * and so missed `tool: "*"`, reporting full-access as if it had been widened.
 * Reimplementing a subset of the matcher is how that mistake happens.
 */
export function wideningRules(config: AgentConfig, postureRules: readonly Rule[]): readonly ConfigRule[] {
  return config.rules.filter((rule) => {
    if (rule.decision !== "allow") return false;
    // Empty arguments are the conservative probe: a rule with a predicate that
    // needs arguments to permit something will not permit them here, so the tool
    // counts as "not already allowed" and gets audited. Over-reporting a widening
    // costs one audit line; under-reporting costs an unrecorded boundary removal.
    return decide(postureRules, rule.tool, {}).decision !== "allow";
  });
}
