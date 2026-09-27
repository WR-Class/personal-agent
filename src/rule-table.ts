/**
 * The permission rule table (D23, D31).
 *
 * One ordered list decides `allow` / `approve` / `deny`. Rules carry a tier and
 * a priority, and the effective priority is `tier + priority/1000`. Because
 * `priority` is clamped below 1000, no priority can lift a rule past the tier
 * above it: a lower tier's best possible score is still below the next tier's
 * worst. That is the whole reason for the clamp — without it, "priority" would
 * silently become a way to overrule the ordering the tiers exist to guarantee.
 *
 * What is deliberately *not* here: path confinement, the write budget, and the
 * session capability set. Those are not permission decisions. Path confinement
 * is an invariant that must hold whatever any rule says, the budget is a
 * per-cycle counter, and the capability set is a property of the session that
 * runs before this table is ever consulted. Modelling them as rules would let a
 * high-priority rule widen them, which is exactly the failure this design must
 * not have. They are enforced separately, and a rule can only choose among
 * decisions that are still available after they have spoken.
 */

/** Higher tier always outranks a lower one, whatever the priority. */
export const RULE_TIERS = {
  DEFAULT: 1,
  EXTENSION: 2,
  WORKSPACE: 3,
  USER: 4,
  ADMIN: 5,
} as const;

export type RuleTier = (typeof RULE_TIERS)[keyof typeof RULE_TIERS];

/** Priority is clamped to 0..999 so it can never cross a tier boundary. */
export const MAX_PRIORITY = 999;

export type Decision = "allow" | "approve" | "deny";

export interface Rule {
  /** Stable name, used in the audit trail. */
  readonly id: string;
  /** Match the tool name; `*` matches every tool. */
  readonly tool: string;
  readonly decision: Decision;
  readonly tier: RuleTier;
  readonly priority: number;
  /** Optional predicate. A predicate that throws denies, never allows. */
  readonly when?: (args: Record<string, unknown>) => boolean;
  /** Shown to the operator or the model when this rule denies. */
  readonly reason?: string;
}

export interface RuleMatch {
  readonly decision: Decision;
  /** The rule that decided, or null when nothing matched. */
  readonly rule: Rule | null;
  readonly reason?: string;
}

/** Effective priority. Priority alone can never reach the next tier. */
export function effectivePriority(rule: Pick<Rule, "tier" | "priority">): number {
  return rule.tier + Math.min(Math.max(rule.priority, 0), MAX_PRIORITY) / 1000;
}

function ruleMatches(rule: Rule, tool: string, args: Record<string, unknown>): boolean {
  if (rule.tool !== "*" && rule.tool !== tool) return false;
  if (!rule.when) return true;
  // Fail closed: a condition that cannot be evaluated denies. An allow that
  // depends on a broken predicate is the one outcome this must never produce.
  try {
    return rule.when(args) === true;
  } catch {
    return false;
  }
}

/**
 * Decide one call. The highest-ranked matching rule wins; when none matches the
 * answer is `deny`, so adding an unknown tool cannot silently widen anything.
 */
export function decide(rules: readonly Rule[], tool: string, args: Record<string, unknown>): RuleMatch {
  const ordered = [...rules].sort((a, b) => effectivePriority(b) - effectivePriority(a));
  for (const rule of ordered) {
    if (ruleMatches(rule, tool, args)) {
      return rule.reason === undefined
        ? { decision: rule.decision, rule }
        : { decision: rule.decision, rule, reason: rule.reason };
    }
  }
  return { decision: "deny", rule: null, reason: "no rule matched; denied by default" };
}
