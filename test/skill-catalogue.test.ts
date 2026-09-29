/**
 * The skill catalogue loader (D84).
 *
 * ⚠️ Two kinds of assertion live here and the difference matters:
 *
 * - **Parse-level**: every refusal branch of `parseSkillCatalogue`, because a
 *   loader that degrades on a corrupt file is indistinguishable from one that
 *   found no skills — and "you have no skills" is the wrong thing to tell someone
 *   who believes they installed one.
 * - **Disk-level**: the end-to-end test writes a real `skills.json` into a real
 *   agent home and asserts the matched prompt reaches the model, with no catalogue
 *   injected by the test. That is the assertion `SAFETY.md` promises — the same
 *   discipline `constraints.test.ts` uses, where the claim "the agent cannot write
 *   the file it is told about" is checked against the disk rather than against a
 *   transcript.
 *
 * ⚠️ Recorded as verified by precedent rather than by a new test here: that the
 * file tools cannot write into the agent home. The mechanism is path-based, not
 * file-based — `runtime.ts:607` folds `this.home` and the store root into
 * `protectedRoots` (D50) — so it covers `skills.json` in that directory exactly as
 * it covers `constraints.json`, which `constraints.test.ts` and `security.test.ts`
 * both pin at the disk level. Re-proving the same mechanism for a second filename
 * in the same directory would add a test without adding a property.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  MAX_SKILL_CATALOGUE_BYTES,
  SKILL_CATALOGUE_VERSION,
  loadSkillCatalogue,
  parseSkillCatalogue,
  skillCataloguePath,
} from "../src/skill-catalogue.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { SessionStore } from "../src/session-store.ts";
import { createEchoAdapter } from "../src/echo-adapter.ts";
import { createTestFixture } from "./fixtures.ts";

const FILE = "skills.json";

function parses(text: string) {
  return parseSkillCatalogue(text, FILE);
}

function refuses(text: string, pattern: RegExp) {
  assert.throws(() => parses(text), pattern, `应当拒绝：${text.slice(0, 120)}`);
}

describe("skill catalogue", () => {
  it("treats a missing file as no skills, which is the state every installation is in today", async () => {
    const fixture = await createTestFixture("skill-catalogue");
    assert.deepEqual(await loadSkillCatalogue(fixture.home), []);
    assert.equal(skillCataloguePath(fixture.home), join(fixture.home, "skills.json"));
  });

  it("parses a valid catalogue and stores the operator's text verbatim", () => {
    const text = JSON.stringify({
      version: SKILL_CATALOGUE_VERSION,
      skills: [
        { id: "video-fetch", scenarios: ["视频下载", "yt-dlp"], prompt: "  用 yt-dlp 抓取，先探测格式。  ", priority: 5 },
        { id: "doc-write", scenarios: ["文档"], prompt: "先列大纲再写正文。" },
      ],
    });
    const skills = parses(text);
    assert.equal(skills.length, 2);
    assert.deepEqual(skills[0], {
      id: "video-fetch",
      scenarios: ["视频下载", "yt-dlp"],
      // ⚠️ Verbatim, not trimmed: rewriting operator text would make the injected
      // block a paraphrase of what they wrote (constraints.ts:140-143).
      prompt: "  用 yt-dlp 抓取，先探测格式。  ",
      priority: 5,
    });
    // No `priority` key at all, rather than `priority: undefined` — the field is
    // optional and a present-but-undefined key would survive a JSON round trip
    // differently than an absent one.
    assert.deepEqual(Object.keys(skills[1]!), ["id", "scenarios", "prompt"]);
  });

  it("refuses a corrupt file instead of reading it as empty", () => {
    refuses("{not json", /不是合法 JSON/);
    refuses("[]", /顶层必须是一个对象/);
    refuses('"x"', /顶层必须是一个对象/);
    refuses('{"version":1}', /缺 skills 字段/);
    refuses('{"version":1,"skills":{}}', /skills 必须是一个数组/);
    refuses(`{"version":${SKILL_CATALOGUE_VERSION + 1},"skills":[]}`, /version 必须是/);
    refuses('{"version":1,"skills":[],"extra":1}', /含未知字段 "extra"/);
  });

  it("refuses permission keys with a message that points at the file which does handle them", () => {
    // Silently ignoring `tier` would leave an operator believing they had widened
    // access. Same treatment constraints.ts gives, and for the same reason.
    refuses('{"version":1,"skills":[],"tier":"middle"}', /不能改权限[\s\S]*config\.json/);
    refuses(
      '{"version":1,"skills":[{"id":"a","scenarios":["x"],"prompt":"p","tool":"shell"}]}',
      /skills\[0\] 含 "tool"[\s\S]*不能改权限/,
    );
  });

  it("refuses malformed entries rather than reinterpreting them", () => {
    refuses('{"version":1,"skills":["x"]}', /skills\[0\] 必须是一个对象/);
    refuses('{"version":1,"skills":[{"scenarios":["x"],"prompt":"p"}]}', /缺 id/);
    refuses('{"version":1,"skills":[{"id":"","scenarios":["x"],"prompt":"p"}]}', /id 是空字符串/);
    refuses('{"version":1,"skills":[{"id":"a","prompt":"p"}]}', /缺 scenarios/);
    refuses('{"version":1,"skills":[{"id":"a","scenarios":"x","prompt":"p"}]}', /缺 scenarios 或它不是数组/);
    refuses('{"version":1,"skills":[{"id":"a","scenarios":[1],"prompt":"p"}]}', /scenarios\[0\] 不是字符串/);
    refuses('{"version":1,"skills":[{"id":"a","scenarios":["x"]}]}', /缺 prompt/);
    refuses('{"version":1,"skills":[{"id":"a","scenarios":["x"],"prompt":"  "}]}', /prompt 是空字符串/);
    refuses('{"version":1,"skills":[{"id":"a","scenarios":["x"],"prompt":"p","unknown":1}]}', /含未知字段 "unknown"/);
    refuses('{"version":1,"skills":[{"id":"a","scenarios":["x"],"prompt":"p","priority":1.5}]}', /priority 必须是安全整数/);
  });

  it("⚠️ refuses a blank scenario, because an empty string is a substring of every request", () => {
    // One malformed entry would otherwise become a skill that always fires.
    // `matchTaskSkill` skips blanks at runtime for the same reason, but a catalogue
    // that cannot express what it means is refused here rather than reinterpreted.
    refuses('{"version":1,"skills":[{"id":"a","scenarios":["ok","  "],"prompt":"p"}]}', /scenarios\[1\] 是空字符串[\s\S]*永远触发/);
  });

  it("refuses an empty scenario list, which is a skill that can never match", () => {
    refuses('{"version":1,"skills":[{"id":"a","scenarios":[],"prompt":"p"}]}', /scenarios 是空数组/);
  });

  it("⚠️ refuses duplicate ids, because an ambiguous audit line is a defect even when the behaviour is defined", () => {
    const entry = { id: "same", scenarios: ["x"], prompt: "p" };
    refuses(JSON.stringify({ version: 1, skills: [entry, entry] }), /id "same" 重复[\s\S]*审计行说不清/);
  });

  it("refuses a catalogue over the byte ceiling instead of truncating it", () => {
    const big = "x".repeat(MAX_SKILL_CATALOGUE_BYTES + 1);
    refuses(
      JSON.stringify({ version: 1, skills: [{ id: "a", scenarios: ["x"], prompt: big }] }),
      new RegExp(`超过上限 ${MAX_SKILL_CATALOGUE_BYTES} 字节`),
    );
  });

  it("reads the catalogue from the agent home on disk, with nothing injected by the test", async () => {
    const fixture = await createTestFixture("skill-catalogue");
    await mkdir(fixture.home, { recursive: true });
    await writeFile(
      skillCataloguePath(fixture.home),
      JSON.stringify({
        version: SKILL_CATALOGUE_VERSION,
        skills: [{ id: "video-fetch", scenarios: ["视频下载"], prompt: "DISK-MARKER-VIDEO" }],
      }),
      "utf8",
    );

    const agent = new AgentRuntime({
      adapter: createEchoAdapter(),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: "catalogue-disk",
      home: fixture.home,
      workspaceRoot: fixture.workspaceRoot,
      systemPrompt: "SYSTEM-MARKER",
      // ⚠️ No `taskPromptSkills` here. That is the point: the catalogue has to come
      // from the file, so this test exercises the loader and the runtime wiring
      // together rather than only the loader.
    });

    const hit = String((await agent.send("帮我做视频下载")).history[0]?.content ?? "");
    assert.ok(hit.includes("DISK-MARKER-VIDEO"), "磁盘上的目录必须真的到达模型");
    assert.ok(hit.includes("SYSTEM-MARKER"), "产品自身的系统文本仍在");
    assert.ok(
      hit.indexOf("SYSTEM-MARKER") < hit.indexOf("DISK-MARKER-VIDEO"),
      "请求派生块仍排在产品文本之后（权威序不因加了加载器而改变）",
    );

    // ⚠️ And a request that matches nothing gets no skill text at all — loading a
    // catalogue must not turn into always injecting one.
    const miss = new AgentRuntime({
      adapter: createEchoAdapter(),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: "catalogue-miss",
      home: fixture.home,
      workspaceRoot: fixture.workspaceRoot,
    });
    const text = String((await miss.send("重构这个函数")).history[0]?.content ?? "");
    assert.ok(!text.includes("DISK-MARKER-VIDEO"), "没有就不匹配：未命中的 skill 一个字都不得进提示词");
    assert.ok(text.includes("本轮意图：build"), "但意图片段仍在");
  });

  it("an injected catalogue wins outright rather than merging with the disk one", async () => {
    const fixture = await createTestFixture("skill-catalogue");
    await mkdir(fixture.home, { recursive: true });
    await writeFile(
      skillCataloguePath(fixture.home),
      JSON.stringify({ version: SKILL_CATALOGUE_VERSION, skills: [{ id: "from-disk", scenarios: ["同一个词"], prompt: "DISK" }] }),
      "utf8",
    );
    const agent = new AgentRuntime({
      adapter: createEchoAdapter(),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: "catalogue-override",
      home: fixture.home,
      workspaceRoot: fixture.workspaceRoot,
      taskPromptSkills: [{ id: "injected", scenarios: ["同一个词"], prompt: "INJECTED" }],
    });
    const text = String((await agent.send("同一个词")).history[0]?.content ?? "");
    // Two sources for one routing decision is how an operator stops being able to
    // tell which skill fired, so one of them has to win completely.
    assert.ok(text.includes("INJECTED"));
    assert.ok(!text.includes("DISK"), "注入的目录不得与磁盘目录合并");
  });
});
