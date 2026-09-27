import { createHash } from "node:crypto";

import { canonicalize } from "./gene.ts";

export interface FileGrant {
  tool: string;
  argumentsJson: string;
  expiresAt: number;
}

const FILE_TOOLS = new Set(["edit_file", "patch_file", "create_file", "delete_file", "rename_file", "batch_files"]);

/** Read is allowed. The six file tools need a grant. Everything else is denied. */
export function filePolicy(tool: string): "allow" | "approve" | "deny" {
  if (tool === "read_file") return "allow";
  if (FILE_TOOLS.has(tool)) return "approve";
  return "deny";
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
