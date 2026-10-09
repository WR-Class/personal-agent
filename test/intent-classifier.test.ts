import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyIntent } from "../src/intent-classifier.ts";

const cases: ReadonlyArray<readonly [string, "fix" | "verify" | "research" | "operate" | "build"]> = [
  ["修复这个 bug", "fix"], ["fix this", "fix"],
  ["测试一下", "verify"], ["run tests", "verify"],
  ["调研一下这个", "research"],
  ["帮我做服务器运维", "operate"], ["deploy now", "operate"],
  ["写一个新功能", "build"], ["build the form", "build"],
];

test("D124: each D124 example routes to its gold intent", () => {
  for (const [text, gold] of cases) {
    const c = classifyIntent(text);
    assert.equal(c.intent, gold, `text=${JSON.stringify(text)}`);
  }
});

test("D124: OOV short prompt still returns a usable intent (priors)", () => {
  // No signal in the weight table → classifier returns priors-based intent
  // with oov=true. The TaskSpec layer then applies its own OOV handling
  // (default to "build" + regex hints).
  const c = classifyIntent("xyzzy");
  assert.equal(c.oov, true);
  assert.ok(["fix", "verify", "research", "operate", "build"].includes(c.intent));
});
