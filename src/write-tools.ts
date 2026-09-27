/**
 * Which tools read, and which tools write.
 *
 * This file exists to hold two plain lists and nothing else, so that every
 * consumer agrees by construction rather than by discipline.
 *
 * Why it is separate, rather than living in `tiers.ts` or `file-policy.ts`: both
 * of those need these lists, and `tiers.ts` already imports `DEFAULT_RULES` from
 * `file-policy.ts`. Putting the lists in either one creates a cycle, and that
 * cycle fails at *runtime* with "cannot access before initialization" while
 * typechecking perfectly — measured. A fact with no dependencies belongs
 * somewhere with no dependencies.
 *
 * The split itself is load-bearing for a reason worth stating once. Tiers decide
 * what is *offered* (absence) and the rule table decides what is *allowed*
 * (denial). Those are different mechanisms answering the same question, so a tool
 * can be offered and then denied — handing the model something it can never
 * successfully call. That happened: an inspection tool was added to one tier's
 * list while the rule table still allowed only `read_file`, and the model was
 * refused with "unknown tool" for doing what it was told. Both lists below are
 * derived into both mechanisms, so the two cannot disagree without a test
 * failing.
 */

/**
 * Reading and searching. Nothing here writes.
 *
 * Belongs to *every* tier: no tier exists to remove the ability to read — they
 * exist to grant writing.
 */
export const READ_ONLY_TOOLS: readonly string[] = ["read_file", "inspect_file"];

/** The write tools, added only by the tiers that allow writing. */
export const WRITE_TOOLS: readonly string[] = [
  "edit_file",
  "patch_file",
  "create_file",
  "delete_file",
  "rename_file",
  "batch_files",
];
