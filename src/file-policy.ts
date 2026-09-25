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
