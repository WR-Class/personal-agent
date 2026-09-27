import { createHash } from "node:crypto";

import { canonicalize } from "./gene.ts";
import { RULE_TIERS, decide } from "./rule-table.ts";
import type { Decision, Rule } from "./rule-table.ts";
import { READ_ONLY_TOOLS } from "./write-tools.ts";

export interface FileGrant {
  tool: string;
  argumentsJson: string;
  expiresAt: number;
}

const FILE_TOOLS = ["edit_file", "patch_file", "create_file", "delete_file", "rename_file", "batch_files"];

/**
 * The built-in rules. These express exactly what the previous hardcoded switch
 * did — read allowed, the six file tools approved, everything else denied — so
 * that swapping the mechanism is not also a change in behaviour. The difference
 * is that behaviour is now data: a rule can be inspected, attributed in the
 * audit trail by id, and overridden by a higher tier without editing this file.
 */
export const DEFAULT_RULES: readonly Rule[] = [
  ...FILE_TOOLS.map((tool): Rule => ({
    id: `file-tools.${tool}`,
    tool,
    decision: "approve",
    tier: RULE_TIERS.WORKSPACE,
    priority: 10,
  })),
  // Every read-only tool gets its own allow, not just `read_file`. Measured
  // consequence of listing only that one: adding an inspection tool left it
  // *offered* by the tier while this table *denied* it, so the model was handed
  // a tool it could never successfully call. Offering and allowing have to agree,
  // and one rule per name is what keeps a wildcard from also admitting writes.
  ...READ_ONLY_TOOLS.map((tool, index): Rule => ({
    id: `read-tool.${tool}`,
    tool,
    decision: "allow",
    tier: RULE_TIERS.WORKSPACE,
    priority: 50 - index,
  })),
];

/** Read is allowed. The six file tools need a grant. Everything else is denied. */
export function filePolicy(tool: string, rules: readonly Rule[] = DEFAULT_RULES): Decision {
  return decide(rules, tool, {}).decision;
}

/**
 * The identity of an approved action, as a content hash (D29).
 *
 * A grant used to be matched by comparing `JSON.stringify(args)` as a string,
 * which is not the same question as "is this the same action": the same call
 * written with its keys in another order produced different text, missed the
 * cache, and asked the operator again. It happens to work while the model
 * repeats itself byte for byte, which is luck rather than a property.
 *
 * Canonicalising first makes the binding depend on the *data* rather than on
 * how it was spelled, so whitespace and key order stop mattering while any
 * change to a value still changes the hash. The tool name is inside the hash,
 * so a grant for one action can never satisfy another.
 */
export function actionBinding(tool: string, args: unknown): string {
  return `sha256:${createHash("sha256").update(canonicalize({ tool, args }), "utf8").digest("hex")}`;
}
