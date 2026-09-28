/**
 * Operator standing constraints (D55 采用清单第 1 项，取证见 D53/D55/D57).
 *
 * The defect this fixes is positional, not deletion. Compaction only replaces
 * `role === "tool"` messages (see `runtime.ts` `buildPrompt`), so a rule the
 * operator stated in turn 3 is never summarised away — but in turn 300 it is
 * still sitting at position 3, behind 297 messages that arrived after it. The
 * video source described this accurately ("随着对话轮次增加被淹没"); the first
 * diagnosis recorded in D53 ("rules get summarized away") was wrong and is
 * corrected there.
 *
 * So the fix is re-injection at a position that cannot be diluted: the system
 * message, which is always the first thing in the prompt. That shape already
 * exists — the compaction summary is a `role: "system"` message inserted ahead
 * of the history — so this adds no new mechanism to the runtime.
 *
 * **The file is re-read on every prompt build, deliberately.** The complaint is
 * about constraints stated mid-conversation; loading once at startup would make
 * the operator restart to apply one, which would not fix the thing they reported.
 * The cost is one small file read per model call, next to the `store.history()`
 * read of the whole session log in the same function.
 *
 * **Re-reading a file the agent cannot write is what keeps this safe.** The agent
 * home is denied to the file tools by location — `AgentRuntime` folds `this.home`
 * and the store root into `protectedRoots` (D50) — so "read it every turn" adds
 * no self-escalation surface. `security.test.ts` and `constraints.test.ts` both
 * pin that with a disk-level assertion, not a transcript assertion.
 *
 * Two things this file is not:
 *
 * - **Not a permission surface.** A constraint is prose. It cannot widen what
 *   `decide()` allows, and an attempt to write permissions here is refused with a
 *   message that points at `config.json` — the same treatment `config.ts` gives
 *   `tier` and `when`. Silently ignoring such a key would leave an operator
 *   believing they had widened access.
 * - **Not a guarantee.** The injected block says so in as many words, following
 *   the attitude `genePrompt` already established: the text is context, "never a
 *   rule the model is trusted to obey". Enforcement stays in the rule table.
 *
 * Expiry and automatic invalidation are D55 采用清单第 5 项, not this round. An
 * operator retires a constraint by deleting the line, which needs no mechanism.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

export const CONSTRAINTS_VERSION = 1;

/**
 * Ceiling on the whole injected block, in bytes.
 *
 * This is a standing-instruction block, not a document. The limit exists because
 * an unbounded registry is how a memory system turns into context pressure (D55
 * 坑③), and because the honest way to handle that is to make it the operator's
 * explicit problem rather than a silent squeeze on every turn. Over the limit
 * throws with the actual size — it is never truncated, for the reason
 * `maxContextBytes` already gives: dropping content quietly changes what the
 * model is being told without anyone being informed.
 */
export const MAX_CONSTRAINT_BYTES = 32_768;

/**
 * Keys that belong to `config.json`. Listed so they get a dedicated refusal
 * instead of the generic "unknown field" one: writing permissions into a
 * constraints file is the mistake an operator is most likely to make here.
 */
const PERMISSION_KEYS: readonly string[] = ["tool", "decision", "tier", "rules", "priority", "when"];

export function constraintsPath(agentHome: string): string {
  return path.join(agentHome, "constraints.json");
}

/**
 * Load the standing constraints from the agent home.
 *
 * A missing file is normal and yields no constraints — most runs have none. Any
 * other read failure throws, and a corrupt file throws rather than being read as
 * empty, following the decision already made for `trust.json` and `config.json`:
 * "read as empty" is indistinguishable from "the operator has no constraints",
 * which is the wrong answer to give someone who believes they set one.
 *
 * **Only the agent home is ever read.** There is deliberately no search for a
 * constraints file in the workspace, so cloning a repository cannot ship
 * standing instructions — the same reason `config.ts` never looks for `.agentrc`.
 */
export async function loadConstraints(agentHome: string): Promise<readonly string[]> {
  const file = constraintsPath(agentHome);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parseConstraints(text, file);
}

export function parseConstraints(text: string, file: string): readonly string[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} 不是合法 JSON；长期约束没有被读取`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} 顶层必须是一个对象，形如 {"version":1,"constraints":["…"]}`);
  }
  const record = parsed as Record<string, unknown>;
  // Checked before the generic unknown-field loop so the operator is pointed at
  // the file that does handle permissions, rather than told the key is a typo.
  for (const key of PERMISSION_KEYS) {
    if (key in record) throw permissionError(file, key);
  }
  for (const key of Object.keys(record)) {
    if (key === "version" || key === "constraints") continue;
    throw new Error(`${file} 含未知字段 ${JSON.stringify(key)}（只接受 version 与 constraints）`);
  }
  if ("version" in record && record.version !== CONSTRAINTS_VERSION) {
    throw new Error(`${file} 的 version 必须是 ${CONSTRAINTS_VERSION}，实际是 ${JSON.stringify(record.version)}`);
  }
  if (!("constraints" in record)) {
    throw new Error(`${file} 缺 constraints 字段；没有约束就写 {"version":1,"constraints":[]}`);
  }
  const entries = record.constraints;
  if (!Array.isArray(entries)) {
    throw new Error(`${file} 的 constraints 必须是一个字符串数组`);
  }
  const constraints = entries.map((entry, index) => {
    if (typeof entry === "object" && entry !== null) {
      for (const key of PERMISSION_KEYS) {
        if (key in (entry as Record<string, unknown>)) throw permissionError(file, key, index);
      }
      throw new Error(`${file} 的 constraints[${index}] 必须是字符串，不是对象（条目不带 id/reason/expires：删掉一行即撤销）`);
    }
    if (typeof entry !== "string") {
      throw new Error(`${file} 的 constraints[${index}] 必须是字符串，实际是 ${entry === null ? "null" : typeof entry}`);
    }
    if (entry.trim() === "") {
      throw new Error(`${file} 的 constraints[${index}] 是空字符串；没有约束就把它从数组里删掉`);
    }
    // Stored verbatim. Rewriting operator text (trimming, normalising) would make
    // the injected block a paraphrase of what they wrote, which is the thing the
    // compaction summary deliberately refuses to be.
    return entry;
  });
  const bytes = constraints.reduce((total, entry) => total + Buffer.byteLength(entry, "utf8"), 0);
  if (bytes > MAX_CONSTRAINT_BYTES) {
    throw new Error(
      `${file} 的约束合计 ${bytes} 字节，超过上限 ${MAX_CONSTRAINT_BYTES} 字节（${constraints.length} 条）；` +
        `它每轮都注入系统提示，请删减或合并，而不是让它挤占每一轮的上下文`,
    );
  }
  return constraints;
}

/**
 * Render the block that rides in the system message.
 *
 * `undefined` when there are no constraints, so the system prompt is byte-for-byte
 * what it was before this feature — an operator with no constraints file gets no
 * injected text and no new failure mode.
 */
export function formatConstraintsForPrompt(constraints: readonly string[]): string | undefined {
  if (constraints.length === 0) return undefined;
  return [
    "操作员长期约束（每轮重新注入，不因对话变长而失效）：",
    constraints.map((entry) => `- ${entry}`).join("\n"),
    "以上是上下文，不是保证：此处文字不放宽任何权限，能由规则表强制的约束不在此列；与档位或规则表冲突时，以档位与规则表为准。",
  ].join("\n");
}

function permissionError(file: string, key: string, index?: number): Error {
  const where = index === undefined ? "顶层" : `constraints[${index}]`;
  return new Error(
    `${file} 的 ${where} 含 ${JSON.stringify(key)}：长期约束是散文，不能改权限。` +
      `要放宽或收紧工具，请用同目录下的 config.json（它会逐条审计放宽项）`,
  );
}
