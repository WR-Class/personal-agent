/**
 * The skill seam (D101): Definition, Provider and Consumer for skill sources.
 *
 * ⚠️ The load-bearing property here is the fourth test. `listSkills` takes the
 * nearest provider's catalogue and does NOT merge, because `runtime.ts:782-788`
 * records that two sources for a single routing decision is how an operator
 * stops being able to tell which skill fired, and because the duplicate-id
 * refusal at `skill-catalogue.ts:157-161` and the byte ceiling at `:163-169`
 * are both enforced per file and cannot see across providers. A test that only
 * checked "a registered provider is used" would pass under a merging
 * implementation too, so the assertion is on the exact array.
 *
 * ⚠️ Registrations are module-global, so every test disposes what it registers.
 * A leaked registration would make the next test's `registerSkillProvider`
 * throw on a duplicate key and report a failure somewhere other than the cause.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  disposeAgentHomeSkillProvider,
  listSkills,
  loadSkillCatalogue,
  registerSkillProvider,
  skillProviderKeys,
  type SkillProvider,
} from "../src/skill-catalogue.ts";
import type { TaskPromptSkill } from "../src/taskspec-prompt.ts";
import { createTestFixture } from "./fixtures.ts";

const SKILL: TaskPromptSkill = { id: "from-plugin", scenarios: ["插件"], prompt: "来自插件的技能。" };

test("内置的 agent-home 提供方在模块作用域就注册好了，且可被列举", () => {
  assert.ok(skillProviderKeys().includes("agent-home"), `实际是 ${JSON.stringify(skillProviderKeys())}`);
});

test("没有 skills.json 时，走接缝与直接读磁盘一样得到空目录", async () => {
  const fixture = await createTestFixture("skill-provider-empty");
  // ⚠️ Not `[]` by accident: the built-in provider delegates to
  // `loadSkillCatalogue`, whose ENOENT path is the state every existing
  // installation is in today.
  assert.deepEqual(await listSkills(fixture.home), []);
});

test("重名提供方直接抛，不是先到先得加一条警告", () => {
  const dispose = registerSkillProvider({ key: "dup", order: 500, list: async () => [] });
  try {
    assert.throws(
      () => registerSkillProvider({ key: "dup", order: 501, list: async () => [] }),
      /技能提供方已注册：dup/,
    );
  } finally {
    dispose();
  }
  assert.ok(!skillProviderKeys().includes("dup"), "dispose 之后 key 不应仍在注册表里");
});

test("更近的提供方整份顶掉内置的那一份，而不是与之合并", async () => {
  const fixture = await createTestFixture("skill-provider-shadow");
  const near: SkillProvider = { key: "near", order: 0, list: async () => [SKILL] };
  const dispose = registerSkillProvider(near);
  try {
    // ⚠️ Exact array, not "contains": a merging implementation would return
    // this too, and would silently break the per-file duplicate-id refusal.
    assert.deepEqual(await listSkills(fixture.home), [SKILL]);
  } finally {
    dispose();
  }
  assert.deepEqual(await listSkills(fixture.home), [], "撤销注册后应回到内置提供方的结果");
});

test("更远的提供方不会顶掉内置的那一份", async () => {
  const fixture = await createTestFixture("skill-provider-far");
  const dispose = registerSkillProvider({ key: "far", order: 900, list: async () => [SKILL] });
  try {
    assert.deepEqual(await listSkills(fixture.home), [], "order 900 比 agent-home 的 100 远，不应生效");
  } finally {
    dispose();
  }
});

test("陈旧的 disposer 不能注销顶替它的同名注册", () => {
  // ⚠️ This is the property the ownership token exists for, copied from
  // `session-store.ts:294-296`: without the token, a disposer captured before a
  // reload would delete the live registration that replaced it.
  const first = registerSkillProvider({ key: "reload", order: 300, list: async () => [] });
  first();
  const second = registerSkillProvider({ key: "reload", order: 300, list: async () => [] });
  first(); // stale: must be a no-op, not a removal of `second`
  assert.ok(skillProviderKeys().includes("reload"), "陈旧 disposer 把活注册删掉了");
  second();
  assert.ok(!skillProviderKeys().includes("reload"));
});

test("内置提供方的 disposer 真的能拆掉它，且拆掉后目录为空", async () => {
  const fixture = await createTestFixture("skill-provider-dispose");
  disposeAgentHomeSkillProvider();
  try {
    assert.ok(!skillProviderKeys().includes("agent-home"));
    assert.deepEqual(await listSkills(fixture.home), [], "没有任何提供方时应得到空目录，而不是抛错");
  } finally {
    // ⚠️ Re-register so later tests and the real product see the built-in
    // provider. The token means this new registration is a different owner.
    // ⚠️ It must delegate to `loadSkillCatalogue`, NOT to `listSkills`: the
    // latter asks the registry for the nearest provider, which is this one, so
    // delegating to it would recurse until the stack went. Writing it that way
    // first was a real bug in this file, caught by reading it back rather than
    // by the suite, because the empty fixture home would have made both versions
    // look plausible.
    registerSkillProvider({
      key: "agent-home",
      order: 100,
      list: (agentHome) => loadSkillCatalogue(agentHome),
    });
  }
});
