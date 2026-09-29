/**
 * TaskSpec → prompt assembly.
 *
 * ⚠️ The test that matters most here is the negative one: when no skill's
 * scenarios overlap the request, nothing is contributed. That is the operator's
 * "如果没有就不匹配" — not a default skill, not the first one, not the highest
 * priority one. A positive-only suite would pass an implementation that always
 * injects something.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assembleTaskPrompt, matchTaskSkill } from "../src/taskspec-prompt.ts";
import type { TaskPromptSkill } from "../src/taskspec-prompt.ts";
import { buildTaskSpec } from "../src/taskspec.ts";
import type { TaskIntent } from "../src/taskspec.ts";

const specFor = (text: string) => buildTaskSpec(text, { mode: "single-agent" });

const VIDEO: TaskPromptSkill = {
  id: "video-fetch",
  scenarios: ["视频下载", "yt-dlp"],
  prompt: "用 yt-dlp 抓取，先探测可用格式再下载。",
  priority: 5,
};
const DOC: TaskPromptSkill = {
  id: "doc-write",
  scenarios: ["文档"],
  prompt: "文档要区分已实现与计划中。",
  priority: 9,
};

describe("assembleTaskPrompt", () => {
  it("always contributes the intent fragment, for every intent", () => {
    const cases: ReadonlyArray<readonly [string, TaskIntent]> = [
      ["加一个功能", "build"],
      ["修复这个 bug", "fix"],
      ["调研一下成熟产品", "research"],
      ["验证测试通过", "verify"],
      ["部署上线", "operate"],
    ];
    for (const [text, intent] of cases) {
      const block = assembleTaskPrompt(specFor(text));
      assert.ok(block !== undefined, `${text} 应当产出提示块`);
      assert.ok(block.includes(`本轮意图：${intent}`), `${text} 应当标出意图 ${intent}`);
      // The fragment has to carry guidance, not just the label — otherwise the
      // block is a no-op that only costs bytes.
      assert.ok(block.length > `本轮意图：${intent}`.length + 10, `${intent} 的片段应当有实际内容`);
    }
  });

  it("injects a matched skill's prompt", () => {
    const block = assembleTaskPrompt(specFor("帮我做视频下载"), [VIDEO, DOC]);
    assert.ok(block !== undefined);
    assert.ok(block.includes("匹配到的能力提示（video-fetch）"), "应当标出命中的 skill id");
    assert.ok(block.includes("用 yt-dlp 抓取"), "应当带上该 skill 的提示词");
  });

  it("⚠️ contributes nothing from skills when none matches — 没有就不匹配", () => {
    const block = assembleTaskPrompt(specFor("重构这个函数"), [VIDEO, DOC]);
    assert.ok(block !== undefined, "意图片段仍然在");
    assert.ok(!block.includes("匹配到的能力提示"), "不得出现任何 skill 段");
    assert.ok(!block.includes("yt-dlp"), "不得泄漏未命中 skill 的内容");
    assert.ok(!block.includes("文档要区分"), "不得退化成注入第一个/最高优先级的 skill");
    assert.equal(matchTaskSkill(specFor("重构这个函数"), [VIDEO, DOC]), undefined);
  });

  it("an empty catalogue yields the intent fragment alone", () => {
    const block = assembleTaskPrompt(specFor("随便做点什么"), []);
    assert.ok(block !== undefined);
    assert.ok(block.includes("本轮意图：build"));
    assert.ok(!block.includes("匹配到的能力提示"));
  });

  it("never returns an empty string", () => {
    // Callers filter empty parts out of the system message; an "" that survived
    // would add a blank block to every model call.
    for (const text of ["", "   ", "修 bug"]) {
      const block = assembleTaskPrompt(specFor(text), [VIDEO]);
      assert.ok(block === undefined || block !== "", `输入 ${JSON.stringify(text)} 不得产出空串`);
    }
  });
});

describe("matchTaskSkill", () => {
  it("matches a scenario through the raw text even when signals are CJK bigrams", () => {
    // `extractSignals` gives CJK runs as bigrams, so the phrase 视频下载 is never
    // a single signal. Substring matching against the request is what makes a
    // phrase-shaped scenario work at all.
    const spec = specFor("我要做视频下载");
    assert.ok(!spec.signals.includes("视频下载"), "前提：整句/整词不是单个 signal");
    assert.equal(matchTaskSkill(spec, [VIDEO])?.id, "video-fetch");
  });

  it("matches an ASCII scenario through signals, case-insensitively", () => {
    assert.equal(matchTaskSkill(specFor("run YT-DLP now"), [VIDEO])?.id, "video-fetch");
  });

  it("more matched scenarios beats higher priority", () => {
    const two = { id: "two", scenarios: ["视频下载", "yt-dlp"], prompt: "T", priority: 1 };
    const one = { id: "one", scenarios: ["yt-dlp"], prompt: "O", priority: 99 };
    assert.equal(matchTaskSkill(specFor("视频下载 with yt-dlp"), [one, two])?.id, "two");
  });

  it("priority breaks a score tie, and declaration order breaks the rest", () => {
    const a = { id: "a", scenarios: ["yt-dlp"], prompt: "A", priority: 1 };
    const b = { id: "b", scenarios: ["yt-dlp"], prompt: "B", priority: 7 };
    assert.equal(matchTaskSkill(specFor("yt-dlp"), [a, b])?.id, "b", "priority 高者胜");
    const c = { id: "c", scenarios: ["yt-dlp"], prompt: "C" };
    const d = { id: "d", scenarios: ["yt-dlp"], prompt: "D" };
    assert.equal(matchTaskSkill(specFor("yt-dlp"), [c, d])?.id, "c", "同分同优先级时先声明者胜 ⇒ 结果确定");
  });

  it("ignores blank scenarios rather than matching everything", () => {
    // An empty scenario substring-matches every request. Treating it as a match
    // would turn a malformed catalogue entry into a skill that always fires.
    const blank = { id: "blank", scenarios: ["", "   "], prompt: "B" };
    assert.equal(matchTaskSkill(specFor("任何请求"), [blank]), undefined);
  });
});
