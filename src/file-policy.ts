export interface FileGrant {
  tool: string;
  argumentsJson: string;
  expiresAt: number;
}

/** Side-effect tools the policy lets reach the operator's approval. */
const APPROVED_TOOLS = new Set(["edit_file", "patch_file", "create_file", "delete_file", "rename_file", "batch_files", "dispatch_workers"]);

/** Read is allowed. Approved side-effect tools need a grant. Everything else is denied. */
export function filePolicy(tool: string): "allow" | "approve" | "deny" {
  if (tool === "read_file") return "allow";
  if (APPROVED_TOOLS.has(tool)) return "approve";
  return "deny";
}
