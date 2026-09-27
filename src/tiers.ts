/**
 * Named permission tiers (D22, D26, D32).
 *
 * A tier is a name for a whole posture, so that a person choosing one is
 * choosing a coherent set of answers rather than assembling them by hand. The
 * names exist only now that the semantics behind them exist: the capability set
 * decides what exists, the rule table decides what is asked, and path
 * confinement and the write budget are invariants that no tier may touch.
 *
 * Two rules from the earlier design work are enforced here rather than trusted:
 *
 * 1. A tier may never widen an invariant. Path confinement and the capability
 *    set are not expressible as rules, so no tier can reach them — this module
 *    can only choose among permission decisions, which is the point.
 * 2. The permissive tier requires an explicit recorded choice. It is not
 *    reachable through a permission label, and `resolveTier` refuses to fall
 *    back to it when a name is unknown. Refusing to *guess* full access is what
 *    keeps a stranger's default safe.
 */

import { RULE_TIERS } from "./rule-table.ts";
import type { Decision, Rule } from "./rule-table.ts";
import { DEFAULT_RULES } from "./file-policy.ts";
import { READ_ONLY_TOOLS, WRITE_TOOLS } from "./write-tools.ts";

export { READ_ONLY_TOOLS, WRITE_TOOLS } from "./write-tools.ts";

export interface Tier {
  readonly name: string;
  readonly summary: string;
  /** Tools this tier does not offer at all. Absence, not denial. */
  readonly tools: readonly string[];
  readonly rules: readonly Rule[];
  /**
   * True when the tier removes a boundary. Selecting one of these is an
   * operator decision that has to be recorded, not a default.
   */
  readonly removesBoundary?: boolean;
}

function denyAllWrites(reason: string): Rule[] {
  return [
    // The allow must rank *above* the wildcard deny, or the deny swallows reads
    // too and the tier becomes "read nothing" rather than "read only". Ordering
    // is the mechanism here, so the numbers are load-bearing, not cosmetic.
    // One allow per read-only tool: a wildcard allow would also admit the write
    // tools, and this tier's whole point is that they are absent.
    ...READ_ONLY_TOOLS.map((tool, index) => ({
      id: `read-only.allow-${tool}`,
      tool,
      decision: "allow" as Decision,
      tier: RULE_TIERS.USER,
      priority: 900 - index,
    })),
    {
      id: "read-only.deny-writes",
      tool: "*",
      decision: "deny",
      tier: RULE_TIERS.USER,
      priority: 800,
      reason,
    },
  ];
}

export const TIERS: readonly Tier[] = [
  {
    name: "read-only",
    summary: "读取与检索；写入类工具在本会话中不存在",
    tools: READ_ONLY_TOOLS,
    rules: denyAllWrites("read-only tier: writing is not available in this session"),
  },
  {
    name: "workspace-write",
    summary: "在工作区内读写；写入仍需逐次批准",
    tools: [...READ_ONLY_TOOLS, ...WRITE_TOOLS],
    rules: DEFAULT_RULES,
  },
  {
    name: "full-access",
    summary: "移除写入门禁；路径收敛、写预算与审计仍然生效",
    tools: [...READ_ONLY_TOOLS, ...WRITE_TOOLS],
    removesBoundary: true,
    rules: [
      { id: "full-access.allow-all", tool: "*", decision: "allow" as Decision, tier: RULE_TIERS.ADMIN, priority: 0 },
    ],
  },
];

/** The tier used when nothing was chosen. Safe for a stranger's first run. */
export const DEFAULT_TIER = "workspace-write";

export function findTier(name: string): Tier | undefined {
  return TIERS.find((tier) => tier.name === name);
}

/**
 * Resolve a tier name, refusing to guess.
 *
 * An unknown name is an error rather than a fallback: silently substituting a
 * tier would mean a typo in a config file changes the posture without anyone
 * being told, and falling back to the permissive one would hand out full access
 * on a misspelling.
 */
export function resolveTier(name: string | undefined): Tier {
  if (name === undefined || name === "") return findTier(DEFAULT_TIER)!;
  const tier = findTier(name);
  if (!tier) {
    throw new Error(`unknown permission tier: ${name} (known: ${TIERS.map((t) => t.name).join(", ")})`);
  }
  return tier;
}
