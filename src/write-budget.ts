/**
 * Per-cycle write budget (D18).
 *
 * A gene's `constraints` were a record, not a rule: `maxFiles` and `maxLines`
 * were written down and nothing enforced them. A constraint that is only
 * recorded is a suggestion, and this module is what turns it into a rule.
 *
 * The ledger is pure arithmetic over what a round has already written. Counting
 * is deliberately conservative: files are counted exactly (distinct paths), and
 * lines are counted only where the tool arguments make them mechanically
 * readable. Where they are not — delete, rename, a patch — the file is counted
 * and the lines are not estimated, because an invented number would make the
 * budget meaningless in exactly the case where it matters.
 */

export interface WriteBudget {
  /** Distinct files this cycle may touch. */
  readonly maxFiles: number;
  /** Lines added plus changed across this cycle. */
  readonly maxLines: number;
}

/** Tools that change the workspace. Reads are not writes. */
const WRITE_TOOL_LINE_ARGUMENT: Readonly<Record<string, string | null>> = {
  edit_file: "content",
  create_file: "content",
  // These change a file without carrying new content in the arguments.
  patch_file: null,
  delete_file: null,
  rename_file: null,
  batch_files: null,
};

export function isWriteTool(tool: string): boolean {
  return Object.hasOwn(WRITE_TOOL_LINE_ARGUMENT, tool);
}

export interface WriteAttempt {
  readonly tool: string;
  /** Workspace-relative path the write targets, when the arguments name one. */
  readonly path: string | null;
  /** Lines the arguments actually carry, or null when they carry none. */
  readonly lines: number | null;
}

/**
 * Read a write attempt out of a tool call. Returns null when the call is not a
 * write. Unparseable arguments are treated as a write with unknown extent: the
 * file is still counted, so malformed arguments cannot buy extra budget.
 */
export function readWriteAttempt(tool: string, argumentsJson: string): WriteAttempt | null {
  if (!isWriteTool(tool)) return null;
  const lineArgument = WRITE_TOOL_LINE_ARGUMENT[tool];
  let parsed: unknown;
  try {
    parsed = JSON.parse(argumentsJson);
  } catch {
    return { tool, path: null, lines: null };
  }
  if (typeof parsed !== "object" || parsed === null) return { tool, path: null, lines: null };
  const record = parsed as Record<string, unknown>;
  const path = typeof record.path === "string" && record.path !== "" ? record.path
    : typeof record.to === "string" && record.to !== "" ? record.to
    : null;
  if (lineArgument === null || lineArgument === undefined) return { tool, path, lines: null };
  const content = record[lineArgument];
  // No readable path means the write cannot be attributed, and no readable
  // content means its extent is unknown. Either way the extent is unknown, so
  // report null rather than a number that would make an unreadable write look
  // cheaper than a readable one.
  if (path === null || typeof content !== "string") return { tool, path, lines: null };
  // A trailing newline ends the last line rather than starting an empty one.
  const lines = content === "" ? 0 : content.split("\n").length - (content.endsWith("\n") ? 1 : 0);
  return { tool, path, lines };
}

export interface LedgerState {
  readonly files: readonly string[];
  readonly lines: number;
}

export interface LedgerDecision {
  readonly allowed: boolean;
  /** Present when the attempt was refused; the operator-facing reason. */
  readonly reason?: string;
}

export class WriteBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WriteBudgetError";
  }
}

/**
 * Decide whether one more write fits, without performing it. Refusing here means
 * the write never happens, so a refusal cannot leave a half-written file behind.
 */
export function checkWrite(
  state: LedgerState,
  attempt: WriteAttempt,
  budget: WriteBudget,
): LedgerDecision {
  if (attempt.path === null) {
    // A write whose target cannot be read from the arguments still consumes
    // budget: it is charged as its own anonymous slot rather than waved through.
    const anonymous = state.files.filter((entry) => entry.startsWith("\u0000")).length;
    if (anonymous + 1 > budget.maxFiles) {
      return refusal(`cycle file budget exhausted (${budget.maxFiles}); a write with no readable path was refused`);
    }
  } else if (!state.files.includes(attempt.path) && state.files.length + 1 > budget.maxFiles) {
    return refusal(`cycle file budget exhausted: ${budget.maxFiles} file(s) per cycle, ${attempt.path} would be number ${state.files.length + 1}`);
  }
  const lines = attempt.lines ?? 0;
  if (state.lines + lines > budget.maxLines) {
    return refusal(`cycle line budget exhausted: ${budget.maxLines} line(s) per cycle, this write adds ${lines} to ${state.lines}`);
  }
  return { allowed: true };
}

function refusal(reason: string): LedgerDecision {
  return { allowed: false, reason };
}

/** Charge an attempt that was actually performed. */
export function chargeWrite(state: LedgerState, attempt: WriteAttempt, index: number): LedgerState {
  const path = attempt.path ?? `\u0000${index}`;
  const files = state.files.includes(path) ? state.files : [...state.files, path];
  return { files, lines: state.lines + (attempt.lines ?? 0) };
}

/** The budget a round runs under: the applied gene's constraints, else the default. */
export function budgetFor(
  constraints: { maxFiles: number; maxLines: number } | null,
  fallback: WriteBudget,
): WriteBudget {
  if (constraints === null) return fallback;
  return { maxFiles: constraints.maxFiles, maxLines: constraints.maxLines };
}
