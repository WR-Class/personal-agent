/**
 * The skill catalogue: which capability prompts exist, and when each one fires
 * (D84; the injection point D81 left ready, and 采用清单第 ③ 点剩下的那一半).
 *
 * **This file is `constraints.ts`'s shape on purpose, not by coincidence.** A
 * skill's prompt ends up in the same place a constraint does — the system
 * message, re-sent every turn — so it inherits the same threat model and gets
 * the same answers:
 *
 * - **Only the agent home is ever read.** There is deliberately no search for a
 *   skills file in the workspace. `constraints.ts:81-83` gives the reason and it
 *   applies unchanged: cloning a repository must not be able to ship instructions
 *   that end up in the system prompt. **⚠️ This is a documented rejection of
 *   WorkBuddy's second skills level** (`{workspace}/.workbuddy-ai/skills/`,
 *   recorded as adopted in `SWARM_LOOP.md:175`): the two-level layout is what
 *   makes a cloned repo able to speak to the model in the product's own voice.
 *   The first level (`~/.workbuddy-ai/skills/`) is the part that survives here.
 * - **Re-reading a file the agent cannot write is what keeps this safe.** The
 *   agent home is denied to the file tools by location — `AgentRuntime` folds
 *   `this.home` and the store root into `protectedRoots` (`runtime.ts:607`, D50)
 *   — so reading it every turn adds no self-escalation surface. **Without that,
 *   an agent which could write its own skill catalogue could instruct itself**,
 *   which is exactly the shape `constraints` exists to refuse. The disk-level
 *   assertion in `skill-catalogue.test.ts` pins it against the disk, not against
 *   a transcript.
 * - **Corrupt means refused, never degraded.** A malformed file throws with the
 *   file and the reason. Reading it as empty would be indistinguishable from "the
 *   operator has no skills", which is the wrong answer to give someone who
 *   believes they installed one — the decision already made for `trust.json`,
 *   `config.json` and `constraints.json`.
 *
 * Two things this file is not, same as `constraints.ts:29-38`:
 *
 * - **Not a permission surface.** A skill is prose plus routing keywords. It
 *   cannot widen what `decide()` allows, and an attempt to write permissions here
 *   is refused with a message pointing at `config.json`. Silently ignoring such a
 *   key would leave an operator believing they had widened access.
 * - **Not a guarantee.** The assembled block rides at the *lowest* authority of
 *   the five system-prompt blocks (D81), and says nothing that enforcement does
 *   not already enforce. Enforcement stays in the rule table.
 *
 * ponytail: no `.tpl` template files, no per-skill enable flag, no expiry, no
 * precedence beyond `priority`. The ceiling on what this can grow into is that a
 * skill is one id, some keywords and a prompt; anything richer belongs in the
 * gene library, which already has strategy, limits and validation.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { TaskPromptSkill } from "./taskspec-prompt.ts";

export const SKILL_CATALOGUE_VERSION = 1;

/**
 * Ceiling on the whole catalogue, in bytes.
 *
 * The same number `constraints.ts` uses, for the same reason: both are injected
 * into the system message on every turn, so both are standing context rather than
 * documents, and an unbounded registry is how a memory system turns into context
 * pressure (D55 坑③). Over the limit throws with the actual size — it is never
 * truncated, because dropping content quietly changes what the model is told
 * without informing anyone.
 *
 * ⚠️ Note this bounds the *catalogue*, not the injected block. Only one skill's
 * prompt is ever injected per turn (`matchTaskSkill` returns at most one), and
 * that injected text is separately charged to the `maxContextBytes / 4` ceiling in
 * `buildPrompt` — the two limits guard different things and neither replaces the
 * other.
 */
export const MAX_SKILL_CATALOGUE_BYTES = 32_768;

/**
 * Keys that belong to `config.json`. Listed so they get a dedicated refusal
 * instead of the generic "unknown field" one — same reasoning as
 * `constraints.ts:66`.
 *
 * ⚠️ **This is that list minus `priority`, and the difference was found by a test,
 * not by reading.** `constraints.ts` refuses `priority` because a constraint
 * carrying one looks like a rule-table entry, and constraints are prose. Here
 * `priority` is a legitimate field: it is the tie-breaker `matchTaskSkill` uses
 * when two skills match the same number of scenarios (D81). Copying the list
 * verbatim made every skill that declared a priority fail with "技能…不能改权限",
 * which is not merely wrong but actively misleading — it accuses the operator of
 * attempting a permission change they did not attempt.
 *
 * **⇒ Rule: when copying a validation list into a new context, check each key
 * against the new schema rather than assuming the list transfers.** A refusal list
 * is not a constant of nature; it is a statement about one file format.
 */
const PERMISSION_KEYS: readonly string[] = ["tool", "decision", "tier", "rules", "when"];

/** Fields a skill entry may carry. Anything else is refused, not ignored. */
const SKILL_KEYS: readonly string[] = ["id", "scenarios", "prompt", "priority"];

export function skillCataloguePath(agentHome: string): string {
  return path.join(agentHome, "skills.json");
}

/**
 * Load the skill catalogue from the agent home.
 *
 * A missing file is normal and yields no skills — that is the state every
 * existing installation is in today, and `assembleTaskPrompt` with an empty
 * catalogue still produces the intent fragment, so nothing degrades. Any other
 * read failure throws.
 */
export async function loadSkillCatalogue(agentHome: string): Promise<readonly TaskPromptSkill[]> {
  const file = skillCataloguePath(agentHome);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parseSkillCatalogue(text, file);
}

export function parseSkillCatalogue(text: string, file: string): readonly TaskPromptSkill[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} 不是合法 JSON；技能目录没有被读取`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} 顶层必须是一个对象，形如 {"version":1,"skills":[…]}`);
  }
  const record = parsed as Record<string, unknown>;
  // Checked before the generic unknown-field loop so the operator is pointed at
  // the file that does handle permissions, rather than told the key is a typo.
  for (const key of PERMISSION_KEYS) {
    if (key in record) throw permissionError(file, key);
  }
  for (const key of Object.keys(record)) {
    if (key === "version" || key === "skills") continue;
    throw new Error(`${file} 含未知字段 ${JSON.stringify(key)}（只接受 version 与 skills）`);
  }
  if ("version" in record && record.version !== SKILL_CATALOGUE_VERSION) {
    throw new Error(`${file} 的 version 必须是 ${SKILL_CATALOGUE_VERSION}，实际是 ${JSON.stringify(record.version)}`);
  }
  if (!("skills" in record)) {
    throw new Error(`${file} 缺 skills 字段；没有技能就写 {"version":1,"skills":[]}`);
  }
  const entries = record.skills;
  if (!Array.isArray(entries)) {
    throw new Error(`${file} 的 skills 必须是一个数组`);
  }

  const skills = entries.map((entry, index) => parseSkill(entry, index, file));

  // ⚠️ Duplicate ids are refused rather than last-one-wins. `matchTaskSkill`
  // breaks score ties by `priority` and then by declaration order, so a duplicate
  // id would still resolve deterministically — but the operator reading the
  // catalogue could not tell which entry fired, and an audit line naming that id
  // would be ambiguous. Ambiguity in a record is a defect even when the behaviour
  // is defined.
  const seen = new Set<string>();
  for (const skill of skills) {
    if (seen.has(skill.id)) throw new Error(`${file} 的 skills 里 id ${JSON.stringify(skill.id)} 重复；id 必须唯一，否则审计行说不清是哪一个触发的`);
    seen.add(skill.id);
  }

  const bytes = skills.reduce((total, skill) => total + Buffer.byteLength(skill.prompt, "utf8"), 0);
  if (bytes > MAX_SKILL_CATALOGUE_BYTES) {
    throw new Error(
      `${file} 的技能提示词合计 ${bytes} 字节，超过上限 ${MAX_SKILL_CATALOGUE_BYTES} 字节（${skills.length} 个）；` +
        `命中的那一个每轮都注入系统提示，请删减或合并，而不是让它挤占每一轮的上下文`,
    );
  }
  return skills;
}

function parseSkill(entry: unknown, index: number, file: string): TaskPromptSkill {
  const where = `skills[${index}]`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`${file} 的 ${where} 必须是一个对象，形如 {"id":"…","scenarios":["…"],"prompt":"…"}`);
  }
  const record = entry as Record<string, unknown>;
  for (const key of PERMISSION_KEYS) {
    if (key in record) throw permissionError(file, key, index);
  }
  for (const key of Object.keys(record)) {
    if (!SKILL_KEYS.includes(key)) {
      throw new Error(`${file} 的 ${where} 含未知字段 ${JSON.stringify(key)}（只接受 ${SKILL_KEYS.join("、")}）`);
    }
  }

  const id = requireString(record.id, `${file} 的 ${where} 缺 id 或 id 不是字符串`);
  if (id.trim() === "") throw new Error(`${file} 的 ${where} 的 id 是空字符串`);

  const prompt = requireString(record.prompt, `${file} 的 ${where} 缺 prompt 或 prompt 不是字符串`);
  if (prompt.trim() === "") throw new Error(`${file} 的 ${where} 的 prompt 是空字符串；没有提示词的技能不会改变模型看到的东西，请删掉它`);

  // ⚠️ scenarios must be a non-empty array of non-blank strings. A blank scenario
  // is a substring of every request, so one malformed entry would become a skill
  // that always fires — `matchTaskSkill` skips blanks at runtime for that reason,
  // but a catalogue that cannot express what it means is refused here instead of
  // being silently reinterpreted. And an empty array is a skill that can never
  // match, which is dead weight the operator almost certainly did not intend.
  if (!Array.isArray(record.scenarios)) {
    throw new Error(`${file} 的 ${where} 缺 scenarios 或它不是数组；scenarios 是触发这个技能的关键词或短语`);
  }
  const scenarios = record.scenarios.map((scenario, at) => {
    const value = requireString(scenario, `${file} 的 ${where}.scenarios[${at}] 不是字符串`);
    if (value.trim() === "") {
      throw new Error(`${file} 的 ${where}.scenarios[${at}] 是空字符串；空串会匹配任何请求，等于让这个技能永远触发`);
    }
    return value;
  });
  if (scenarios.length === 0) {
    throw new Error(`${file} 的 ${where} 的 scenarios 是空数组；一个永远不会命中的技能没有意义，请给它关键词或删掉它`);
  }

  let priority: number | undefined;
  if (record.priority !== undefined) {
    if (typeof record.priority !== "number" || !Number.isSafeInteger(record.priority)) {
      throw new Error(`${file} 的 ${where} 的 priority 必须是安全整数，实际是 ${JSON.stringify(record.priority)}`);
    }
    priority = record.priority;
  }

  // ⚠️ Stored verbatim, like `constraints.ts:140-143`: rewriting the operator's
  // text would make the injected block a paraphrase of what they wrote.
  return priority === undefined ? { id, scenarios, prompt } : { id, scenarios, prompt, priority };
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  return value;
}

function permissionError(file: string, key: string, index?: number): Error {
  const where = index === undefined ? "顶层" : `skills[${index}]`;
  return new Error(
    `${file} 的 ${where} 含 ${JSON.stringify(key)}：技能是提示词与触发关键词，不能改权限。` +
      `要放宽或收紧工具，请用同目录下的 config.json（它会逐条审计放宽项）`,
  );
}

/**
 * A source of skills: the Definition role of the skill seam.
 *
 * `docs_architecture.md:117` is explicit that a seam has three roles and that
 * "one role alone is not a seam", so this interface means something only
 * together with {@link registerSkillProvider} (Provider) and {@link listSkills}
 * (Consumer, called from `runtime.ts`). The shape is copied from this
 * repository's own existing seam, `session-store.ts:298-311`, rather than from
 * an external product: key validation, duplicate refusal, a disposer, an
 * ownership token, and an auditable listing.
 *
 * ⚠️ `list` takes the agent home rather than closing over it. The home is a
 * runtime parameter, not module state, so a provider that captured it could not
 * be registered once at module scope the way `session-store.ts:318-320`
 * registers the core's own projection. Passing it keeps that property and gives
 * a third-party provider the same path the built-in one uses.
 */
export interface SkillProvider {
  /** Identity in the registry. Two providers may not share one. */
  readonly key: string;
  /** Lower is nearer. The nearest provider's catalogue is the only one used. */
  readonly order: number;
  list(agentHome: string): Promise<readonly TaskPromptSkill[]>;
}

const skillProviders = new Map<
  string,
  { readonly token: symbol; readonly provider: SkillProvider }
>();

/**
 * Register a skill source. Ownership is a unique token for the same reason as
 * in `session-store.ts:294-296`: matching on the provider's identity would let
 * a stale disposer from a reload unregister the live registration behind it.
 *
 * ⚠️ A duplicate key throws rather than warning. DSH's skill registry is
 * lenient here (first registration wins, with a warning), and this project
 * deliberately is not: skills are part of the capability surface, and
 * `skill-catalogue.ts:151-156` already states the stronger reason — "Ambiguity
 * in a record is a defect even when the behaviour is defined."
 */
export function registerSkillProvider(provider: SkillProvider): () => void {
  if (typeof provider.key !== "string" || provider.key.trim() === "") {
    throw new Error("技能提供方的 key 必须是非空字符串");
  }
  if (!Number.isSafeInteger(provider.order)) {
    throw new Error(
      `技能提供方 ${JSON.stringify(provider.key)} 的 order 必须是安全整数，实际是 ${JSON.stringify(provider.order)}`,
    );
  }
  if (typeof provider.list !== "function") {
    throw new Error(`技能提供方 ${JSON.stringify(provider.key)} 缺 list 方法`);
  }
  if (skillProviders.has(provider.key)) {
    throw new Error(`技能提供方已注册：${provider.key}`);
  }
  const token = Symbol(provider.key);
  skillProviders.set(provider.key, { token, provider });
  return () => {
    const current = skillProviders.get(provider.key);
    if (current !== undefined && current.token === token) skillProviders.delete(provider.key);
  };
}

/** The registered provider keys. What can be listed can be audited. */
export function skillProviderKeys(): readonly string[] {
  return [...skillProviders.keys()];
}

/**
 * The catalogue to route against: the NEAREST provider's, and nothing else.
 *
 * ⚠️ This does not merge, and that is not an oversight. `runtime.ts:782-788`
 * records why an injected catalogue "wins outright rather than merging with the
 * disk one: two sources for a single routing decision is how an operator stops
 * being able to tell which skill fired." Merging would also silently break two
 * invariants that are enforced per file and therefore cannot see across
 * providers: the duplicate-id refusal at `:157-161` and the byte ceiling at
 * `:163-169`. So a second provider SHADOWS the first entirely. That is a strong
 * semantic and it is stated here rather than discovered later.
 *
 * ⚠️ Merging stays closed until skills carry a source key that
 * `taskspec-prompt.ts:111` prints alongside the matched id, and until the two
 * per-file invariants above are lifted to the merged list.
 *
 * No providers registered yields no skills, which is the state every existing
 * installation is in today; per `:98-105` a missing catalogue is a valid empty
 * state and any other read failure throws rather than looking like a deletion.
 */
export async function listSkills(agentHome: string): Promise<readonly TaskPromptSkill[]> {
  let nearest: SkillProvider | undefined;
  for (const { provider } of skillProviders.values()) {
    if (nearest === undefined || provider.order < nearest.order) nearest = provider;
  }
  return nearest === undefined ? [] : nearest.list(agentHome);
}

/**
 * The built-in provider: the agent home's `skills.json`, which is what D84
 * built and what every installation has today. Registered at module scope so it
 * happens once per process rather than once per runtime, matching
 * `session-store.ts:318-320`.
 *
 * ⚠️ `order: 100` leaves room either side for a provider that should shadow it
 * or be shadowed by it. The disposer is exported so a test can prove the
 * explicit-failure path; nothing calls it in normal operation.
 */
export const disposeAgentHomeSkillProvider = registerSkillProvider({
  key: "agent-home",
  order: 100,
  list: (agentHome) => loadSkillCatalogue(agentHome),
});
