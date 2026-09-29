/**
 * TaskSpec → prompt assembly.
 *
 * ⚠️ This is the half of the operator's definition that was missing. The
 * definition is: *"分析意图并匹配提示词或者组装一份好的提示词，如果有相应的
 * skill 应该匹配相应的 skill 如果没有就不匹配。然后发送给大模型。"* Before this
 * module existed, `buildTaskSpec`'s result was used only to gate and score gene
 * selection (`runtime.ts:713-728`) and to journal the outcome — its `objective`,
 * `intent` and `signals` never reached the prompt. The only request-derived text
 * the model saw was the selected gene's block.
 *
 * Two branches, matching the two halves of "匹配提示词或者组装一份好的提示词":
 *
 * 1. **intent fragment** — always present, because the intent is always
 *    classified (five values, `build` by default). This is what makes the module
 *    do something real in production from the first round rather than being
 *    scaffolding for a catalogue that does not exist yet.
 * 2. **skill match** — present only when a curated skill's scenarios actually
 *    overlap the request. *"如果没有就不匹配"* is implemented literally: no
 *    overlap contributes nothing, not a fallback and not a default skill.
 *
 * The skill shape follows the WorkBuddy precedent already adopted at
 * `SWARM_LOOP.md:175` (`curated-experts.json` = `{id, scenarios, description,
 * priority}`, scenario-keyword routing). Its style/persona layer is deliberately
 * not copied — D14 records that as "后补".
 *
 * ponytail: skills are injected, not loaded. The JSON catalogue this predicted
 * has landed — D84's `skill-catalogue.ts` reads `skills.json` from the agent
 * home, ENOENT yields no skills and any other read failure throws, and
 * `runtime.ts:789-790` loads it and passes it in here. The prediction below it
 * held: this assembly did not change when the catalogue landed.
 *
 * ⚠️ Read `priority` (:42) and the tie-break (:71-72) before proposing a
 * "rank" field. Score, then `priority`, then declaration order *is* the
 * three-level order DSH documents for its skill registry, so the concept is
 * present under a different name. D95 recorded `priority` as removed by D84;
 * it was not — D84 removed it from `constraints.ts:66`'s *refusal* list
 * precisely so that it stays legal as a skill field here.
 */
import type { TaskIntent, TaskSpec } from "./taskspec.ts";

/** A curated capability prompt, routed by scenario keywords. */
export interface TaskPromptSkill {
  readonly id: string;
  /** Keywords or short phrases; a request matches when one appears in it. */
  readonly scenarios: readonly string[];
  /** The capability prompt contributed when this skill matches. */
  readonly prompt: string;
  /** Higher wins a tie. Absent is treated as 0. */
  readonly priority?: number;
}

/**
 * One short fragment per intent.
 *
 * ⚠️ These say what the round has to *produce*, not how to behave — behaviour
 * rules live in `systemPrompt` (the product's) and `constraints` (the
 * operator's), and this block is appended after both, so it cannot displace
 * either. Keeping them about the deliverable is what keeps this block the
 * lowest-authority one, which is where `buildPrompt` puts it.
 */
const INTENT_PROMPTS: Readonly<Record<TaskIntent, string>> = {
  build: "本轮意图是「构建」：交付可运行的实现，而不是设计描述。范围只覆盖本次请求，不为将来可能出现的形态预留抽象。",
  fix: "本轮意图是「修复」：先定位根因再改，并给出能复现该缺陷的测试；修好的判据是那个测试由红变绿，不是「看起来对了」。",
  research: "本轮意图是「调研」：只读取证，不改产品代码。每条结论都要能指到具体文件与行；读不到就写「未读，不下结论」，不用推断填补。",
  verify: "本轮意图是「验证」：跑既有的验证命令并如实报退出码与输出，包括对己不利的结果；不声称未跑过的检查已通过。",
  operate: "本轮意图是「运维」：任何不可逆或有外部副作用的动作先说明再执行；失败要可回滚，且回滚步骤与执行步骤一起给出。",
};

/**
 * Pick the skill whose scenarios best match the request.
 *
 * Matching is substring-based against the request text **and** exact-match
 * against `spec.signals`, because `extractSignals` lowercases, strips
 * punctuation and — for CJK, which has no word boundaries — emits bigrams. A
 * scenario written as a phrase therefore matches through the raw text, while a
 * scenario written as a single token can match through the signals.
 *
 * Score is the number of matched scenarios; `priority` breaks ties; earlier
 * declaration wins a remaining tie, so the result is deterministic.
 *
 * ⚠️ Returns `undefined` on no overlap. That is the operator's *"如果没有就不
 * 匹配"* — not a default skill, not the first one, not the highest priority one.
 */
export function matchTaskSkill(spec: TaskSpec, skills: readonly TaskPromptSkill[]): TaskPromptSkill | undefined {
  const haystack = spec.originalInput.toLowerCase();
  let best: TaskPromptSkill | undefined;
  let bestScore = 0;
  let bestPriority = 0;
  for (const skill of skills) {
    let score = 0;
    for (const raw of skill.scenarios) {
      const scenario = raw.trim().toLowerCase();
      if (scenario === "") continue;
      if (haystack.includes(scenario) || spec.signals.includes(scenario)) score += 1;
    }
    if (score === 0) continue;
    const priority = skill.priority ?? 0;
    if (score > bestScore || (score === bestScore && priority > bestPriority)) {
      best = skill;
      bestScore = score;
      bestPriority = priority;
    }
  }
  return best;
}

/**
 * Assemble the request-derived prompt block, or `undefined` when there is
 * nothing to say.
 *
 * ⚠️ Never returns `""`: callers filter empty parts out of the system message,
 * and an empty string that survives would add a blank block to every call.
 */
export function assembleTaskPrompt(spec: TaskSpec, skills: readonly TaskPromptSkill[] = []): string | undefined {
  const parts: string[] = [`本轮意图：${spec.intent}`, INTENT_PROMPTS[spec.intent]];
  const matched = matchTaskSkill(spec, skills);
  if (matched !== undefined) {
    parts.push(`匹配到的能力提示（${matched.id}）`, matched.prompt);
  }
  const block = parts.filter((part) => part !== "").join("\n");
  return block === "" ? undefined : block;
}
