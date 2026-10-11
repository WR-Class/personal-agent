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
 *
 * `job_output` is here because reading a job's output changes nothing; it is a
 * view of work that was already permitted to start. Every tier offers it, so a
 * read-only session can still see what a background job produced.
 *
 * `obs_recall` belongs alongside it for the same reason (D52): it reads session
 * data the model already owns — a tool result that was replaced by an omission
 * placeholder, already in the log this session holds. It has no path argument,
 * so the "offered" and "permitted" lists here cannot disagree about reach.
 */
export const READ_ONLY_TOOLS: readonly string[] = ["read_file", "inspect_file", "job_output", "obs_recall"];

/**
 * Tools that change something outside the conversation.
 *
 * `run_command` belongs here rather than in the read-only list even though many
 * commands only read: the tool itself makes no such promise, and a classification
 * that assumed it would be a guess about arbitrary input. The consequence is
 * intended — a tier that does not offer it genuinely does not have it, which is
 * what makes the read-only posture mean something.
 */
export const WRITE_TOOLS: readonly string[] = [
  "run_command",
  "job_kill",
  // It writes no file, but it changes what every later prompt tells the model, so
  // it is a write in the only sense this list cares about. Leaving it out would
  // hand a read-only posture a way to edit its own instructions — and the tier and
  // rule tables both derive from this list, so the two cannot drift apart.
  //
  // ⚠️ D163: being on this list is what makes it **absent** from a read-only
  // session. It is no longer what makes it **ask** — see `UNASKED_WRITE_TOOLS`
  // below. This list used to answer both questions at once; they are now separate.
  "update_task_state",
  "edit_file",
  "patch_file",
  "create_file",
  "delete_file",
  "rename_file",
  "batch_files",
];

/**
 * Writes that ask nobody, because what they change is the agent's own record (D163).
 *
 * The distinction is *whose* thing changes. Everything else in `WRITE_TOOLS` changes
 * something the operator owns — a file in the workspace, a process they started — and
 * asking is how they keep authority over it. This one appends to the session log the
 * agent already owns.
 *
 * It stays on `WRITE_TOOLS` as well, and that is not redundancy: the write list is
 * what a read-only session's *absence* is derived from, and a read-only session must
 * not be able to rewrite what every later prompt tells the model. So it is offered
 * like a write and asked about like a read.
 *
 * ⚠️ Why it stopped asking, measured rather than argued. The rule table gave it an
 * `approve` decision, so in a headless run — a prompt on the command line, no approval
 * channel — the call came back "no approval channel is configured". The model could
 * then not record what it was doing **at all**, which empties the task-state mechanism
 * precisely where automation needs it: the acceptance criteria, the unpaid-check debt
 * and the notice that asks the model to pay it all read from that record. Asking a
 * question nobody can answer buys no authority; it only turns the feature off.
 *
 * Every consumer derives from this list, so naming the tool once here is what keeps
 * the tier tables and the rule tables from disagreeing. A test pins the membership
 * relationship between the two lists, because two lists can drift.
 */
export const UNASKED_WRITE_TOOLS: readonly string[] = ["update_task_state"];
