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

test("classifier routes 5 intents", () => {
  for (const [text, expected] of cases) {
    const r = classifyIntent(text);
    assert.equal(r.intent, expected, `${text} got ${r.intent}`);
    assert.ok(r.probability > 0);
  }
});
test("OOV prompt is flagged, not silently decided", () => {
  // Noul answers are independent marginals, not a distribution, so there is no
  // "sums to 1" invariant. The property that matters is the flag: the caller
  // must not treat a prior-driven answer as a decision.
  const r = classifyIntent("xyzzy plugh foobar");
  assert.equal(r.oov, true);
  assert.ok(r.probability < 0.6, `OOV top-prob ${r.probability} should stay modest`);
});

test("clear instruction is not contaminated by history", () => {
  // "修这个 bug" matches "修" + "bug" → fix 0.247, verify 0.176, margin 0.071.
  // MARGIN_TRUST_FLOOR is 0.05, so 0.071 > 0.05 → histWeight 0, pure signal.
  // History "research" cannot displace the clear fix.
  const history = [{ intent: "research" as const, prompt: "调研 Jev 是什么" }];
  const r = classifyIntent("修这个 bug", history);
  assert.equal(r.intent, "fix", `clear fix should win over research history (got ${r.intent})`);
});

test("OOV prompt blends strongly with history", () => {
  // "继续" → no signal matched, OOV. histWeight = 0.6 (OOV_HISTORY_WEIGHT).
  // last=fix → blended fix wins.
  const history = [{ intent: "fix" as const, prompt: "修登录 bug" }];
  const r = classifyIntent("继续", history);
  assert.equal(r.intent, "fix", `继续 + fix history should resolve to fix (got ${r.intent})`);
});

test("OK, 好, 行 all blend with history (no phrase list)", () => {
  // These all carry no signal in the weight table — they are OOV. With
  // history they should all lean toward the previous intent. Without a
  // trigger-word list, this just falls out of the OOV flag.
  const history = [{ intent: "build" as const, prompt: "加登录功能" }];
  for (const ack of ["好", "好的", "OK", "ok", "行", "嗯", "可以"]) {
    const r = classifyIntent(ack, history);
    assert.equal(r.intent, "build", `${ack} + build history should resolve to build (got ${r.intent})`);
  }
});

test("long OOV prompt also blends with history (no length gate)", () => {
  // "xyzzy plugh foobar" is long but OOV. The structural rule (length <= 8)
  // would have missed this case; the OOV flag catches it.
  const history = [{ intent: "research" as const, prompt: "调研 Jev 是什么" }];
  const noHistory = classifyIntent("xyzzy plugh foobar");
  const withHistory = classifyIntent("xyzzy plugh foobar", history);
  // Sanity: OOV base layer + history becomes non-OOV at the blended layer.
  assert.equal(noHistory.oov, true);
  assert.equal(withHistory.oov, false);
});

test("without history, behavior is unchanged (backward compat)", () => {
  // Callers that don't pass history get the original signal-only result.
  // This is the contract: history is opt-in.
  const r = classifyIntent("xyzzy plugh foobar");
  assert.equal(r.oov, true);
  const r2 = classifyIntent("修这个 bug");
  assert.equal(r2.intent, "fix");
  assert.equal(r2.probability > 0, true);
});

test("weak-signal non-OOV blends modestly with history", () => {
  // "修修修" matches "修" once → top prob ~0.30 with small margin. histWeight
  // = max(0, 0.05 - margin) is small but non-zero. With build history, the
  // result should still favor fix (since "修" is a fix signal) but with
  // a noticeable build boost.
  const history = [{ intent: "build" as const, prompt: "加登录功能" }];
  const r = classifyIntent("修修修", history);
  // The key property: build gets a meaningful boost, not zero.
  // We don't assert fix vs build here — the gradient is in the magnitudes.
  const buildAlt = r.alternatives.find((a) => a.intent === "build");
  // If fix is the top, then build is somewhere in alternatives; the exact
  // value depends on weights, but it should be > 0.
  if (r.intent !== "build") {
    assert.ok(buildAlt, "build should appear in alternatives when blended with build history");
    assert.ok(buildAlt.probability > 0, "build alt probability should be > 0 after blend");
  }
});

test("history weight is 0 when signal is decisive", () => {
  // Direct check: a prompt with margin > 0.05 has histWeight 0. The pure
  // signal result is the answer.
  const history = [{ intent: "operate" as const, prompt: "部署到生产" }];
  const r = classifyIntent("修这个 bug", history);
  // Decisive signal: history doesn't appear anywhere near the top.
  assert.equal(r.intent, "fix");
  // The fix prob should match the signal-based result exactly (no blend).
  const r2 = classifyIntent("修这个 bug");
  assert.equal(r2.intent, "fix");
  assert.equal(r.probability, r2.probability, "decisive signal: history should not move the probability");
});

// === v5: AI state context ===

test("v5: planNext boosts OOV history weight (0.6 → 0.7)", () => {
  // "继续" + history with planNext → higher blend (0.7) than without (0.6).
  // Higher weight means the blended probability tilts more toward the
  // last intent — fix should win more decisively.
  const withoutPlan = [{ intent: "fix" as const, prompt: "修登录 bug" }];
  const withPlan = [{
    intent: "fix" as const,
    prompt: "修登录 bug",
    aiState: { didWhat: "修了 1/3 文件", completed: false, planNext: "应用 fix-2.patch" },
  }];
  const r1 = classifyIntent("继续", withoutPlan);
  const r2 = classifyIntent("继续", withPlan);
  assert.equal(r1.intent, "fix");
  assert.equal(r2.intent, "fix");
  // planNext version has higher fix probability.
  assert.ok(r2.probability > r1.probability, `planNext should boost fix prob (${r2.probability.toFixed(3)} > ${r1.probability.toFixed(3)})`);
});

test("v5: loop detection fires on dominant actionSigs across 5 rounds", () => {
  // D142: AI keeps doing the same read_file on login.ts across 5 rounds.
  // actionSigs are identical (same name, same args) → dominant 5/5 → loop.
  const same = ["read_file|{\"path\":\"login.ts\"}"];
  const history = [
    { intent: "fix" as const, prompt: "修登录", aiState: { didWhat: "called read_file", completed: false, actionSigs: same } },
    { intent: "fix" as const, prompt: "继续", aiState: { didWhat: "called read_file", completed: false, actionSigs: same } },
    { intent: "fix" as const, prompt: "继续", aiState: { didWhat: "called read_file", completed: false, actionSigs: same } },
    { intent: "fix" as const, prompt: "继续", aiState: { didWhat: "called read_file", completed: false, actionSigs: same } },
    { intent: "fix" as const, prompt: "继续", aiState: { didWhat: "called read_file", completed: false, actionSigs: same } },
  ];
  const r = classifyIntent("继续", history);
  assert.ok(r.loop, "loop should be detected");
  assert.equal(r.loop!.detected, true);
  assert.equal(r.loop!.roundsSinceProgress, 5);
});

test("v5: loop detection does NOT fire when actionSigs differ across rounds", () => {
  // D142: AI's tools progress — different args each round → no dominance.
  const history = [
    { intent: "fix" as const, prompt: "修登录", aiState: { didWhat: "called edit_file", completed: false, actionSigs: ["edit_file|{\"line\":1}"] } },
    { intent: "fix" as const, prompt: "继续", aiState: { didWhat: "called edit_file", completed: false, actionSigs: ["edit_file|{\"line\":2}"] } },
    { intent: "fix" as const, prompt: "继续", aiState: { didWhat: "called edit_file", completed: false, actionSigs: ["edit_file|{\"line\":3}"] } },
    { intent: "fix" as const, prompt: "继续", aiState: { didWhat: "called edit_file", completed: false, actionSigs: ["edit_file|{\"line\":4}"] } },
    { intent: "fix" as const, prompt: "继续", aiState: { didWhat: "called edit_file", completed: false, actionSigs: ["edit_file|{\"line\":5}"] } },
  ];
  const r = classifyIntent("继续", history);
  assert.equal(r.loop?.detected ?? false, false, "distinct actionSigs should not be a loop");
});

test("v5: loop detection requires aiState on every watched round", () => {
  // Pre-v5 history without aiState → no loop signal, even if intents repeat.
  // D142 window is 5, so we need 5 rounds.
  const history = [
    { intent: "fix" as const, prompt: "修登录" },
    { intent: "fix" as const, prompt: "继续" },
    { intent: "fix" as const, prompt: "继续" },
    { intent: "fix" as const, prompt: "继续" },
    { intent: "fix" as const, prompt: "继续" },
  ];
  const r = classifyIntent("继续", history);
  assert.equal(r.loop?.detected ?? false, false, "missing aiState should not trigger loop");
});

test("v5: history without aiState still works (backward compat)", () => {
  // Pre-v5 history shape (just intent + prompt) is still accepted.
  const oldHistory = [{ intent: "fix" as const, prompt: "修登录" }];
  const r = classifyIntent("继续", oldHistory);
  assert.equal(r.intent, "fix", "old history shape should still drive OOV blend");
  assert.equal(r.loop?.detected ?? false, false, "no aiState means no loop signal");
});

test("v5: completed=true changes weight dynamics (tighter loop check)", () => {
  // When AI reports completed=true and user says "继续", the result should
  // still lean on history but the loop detector has a known-stable target
  // to compare against. This is a sanity check that the field is wired up.
  const history = [{
    intent: "build" as const,
    prompt: "加登录功能",
    aiState: { didWhat: "实现 + 测试", completed: true, planNext: "部署" },
  }];
  const r = classifyIntent("继续", history);
  assert.equal(r.intent, "build");
  // No loop yet — only 1 round of history.
  assert.equal(r.loop?.detected ?? false, false);
});

// === D142: 5-round window + dominant action detection ===

test("D142: 3 in a row exact same action (sub-threshold count) does NOT fire", () => {
  // D142 requires 5 rounds minimum and ≥ 3 dominant count. 3 rounds
  // alone are below the window → "history too short", not "loop".
  const same = ["edit_file|{\"line\":1}"];
  const history = [
    { intent: "fix" as const, prompt: "修", aiState: { didWhat: "called edit_file", completed: false, actionSigs: same } },
    { intent: "fix" as const, prompt: "继续", aiState: { didWhat: "called edit_file", completed: false, actionSigs: same } },
    { intent: "fix" as const, prompt: "继续", aiState: { didWhat: "called edit_file", completed: false, actionSigs: same } },
  ];
  const r = classifyIntent("继续", history);
  assert.equal(r.loop?.detected ?? false, false, "3 rounds < 5-round window");
});

test("D142: 5 distinct actions across 5 rounds → no loop", () => {
  // 5 different actionSigs, each count 1 → no dominant → no loop.
  const history = [
    { intent: "fix" as const, prompt: "p1", aiState: { didWhat: "", completed: false, actionSigs: ["a|1"] } },
    { intent: "fix" as const, prompt: "p2", aiState: { didWhat: "", completed: false, actionSigs: ["b|2"] } },
    { intent: "fix" as const, prompt: "p3", aiState: { didWhat: "", completed: false, actionSigs: ["c|3"] } },
    { intent: "fix" as const, prompt: "p4", aiState: { didWhat: "", completed: false, actionSigs: ["d|4"] } },
    { intent: "fix" as const, prompt: "p5", aiState: { didWhat: "", completed: false, actionSigs: ["e|5"] } },
  ];
  const r = classifyIntent("继续", history);
  assert.equal(r.loop?.detected ?? false, false);
});

test("D142: 3A + 1B + 1C (A dominates at 60%) → loop", () => {
  // A appears 3 times in 5 actions, ratio 60% > 50%, count 3 ≥ 3 → loop.
  const history = [
    { intent: "fix" as const, prompt: "p1", aiState: { didWhat: "", completed: false, actionSigs: ["A"] } },
    { intent: "fix" as const, prompt: "p2", aiState: { didWhat: "", completed: false, actionSigs: ["A"] } },
    { intent: "fix" as const, prompt: "p3", aiState: { didWhat: "", completed: false, actionSigs: ["B"] } },
    { intent: "fix" as const, prompt: "p4", aiState: { didWhat: "", completed: false, actionSigs: ["A"] } },
    { intent: "fix" as const, prompt: "p5", aiState: { didWhat: "", completed: false, actionSigs: ["C"] } },
  ];
  const r = classifyIntent("继续", history);
  assert.equal(r.loop?.detected, true, "A 3/5 = 60% should be a loop");
});

test("D142: 2A + 2B + 1C (no one dominates) → no loop", () => {
  // Each top sig is 2/5 = 40% < 50% → not a loop.
  const history = [
    { intent: "fix" as const, prompt: "p1", aiState: { didWhat: "", completed: false, actionSigs: ["A"] } },
    { intent: "fix" as const, prompt: "p2", aiState: { didWhat: "", completed: false, actionSigs: ["B"] } },
    { intent: "fix" as const, prompt: "p3", aiState: { didWhat: "", completed: false, actionSigs: ["A"] } },
    { intent: "fix" as const, prompt: "p4", aiState: { didWhat: "", completed: false, actionSigs: ["B"] } },
    { intent: "fix" as const, prompt: "p5", aiState: { didWhat: "", completed: false, actionSigs: ["C"] } },
  ];
  const r = classifyIntent("继续", history);
  assert.equal(r.loop?.detected ?? false, false, "40% top is below the 50% threshold");
});

test("D142: user example — A,B,B,C,B,B over 6 rounds → loop fires at round 6", () => {
  // The user's exact case: AI keeps going back to B (4 of last 5 = 80%).
  const history = [
    { intent: "fix" as const, prompt: "p1", aiState: { didWhat: "", completed: false, actionSigs: ["A"] } },
    { intent: "fix" as const, prompt: "p2", aiState: { didWhat: "", completed: false, actionSigs: ["B"] } },
    { intent: "fix" as const, prompt: "p3", aiState: { didWhat: "", completed: false, actionSigs: ["B"] } },
    { intent: "fix" as const, prompt: "p4", aiState: { didWhat: "", completed: false, actionSigs: ["C"] } },
    { intent: "fix" as const, prompt: "p5", aiState: { didWhat: "", completed: false, actionSigs: ["B"] } },
    { intent: "fix" as const, prompt: "p6", aiState: { didWhat: "", completed: false, actionSigs: ["B"] } },
  ];
  const r = classifyIntent("继续", history);
  assert.equal(r.loop?.detected, true, "B 4/5 = 80% should be a loop");
});

test("D142: 2 actions per round, repeated → loop fires faster", () => {
  // If a round calls the same 2 tools, actionSigs has 2 entries, and
  // repeated 5 rounds means 10 total entries, all matching. Both
  // unique sigs hit max count 5/10 = 50% → loop fires.
  const same = ["edit_file|{\"line\":1}", "run_command|{\"cmd\":\"test\"}"];
  const history = [];
  for (let i = 0; i < 5; i++) {
    history.push({
      intent: "fix" as const,
      prompt: `p${i}`,
      aiState: { didWhat: "", completed: false, actionSigs: same },
    });
  }
  const r = classifyIntent("继续", history);
  assert.equal(r.loop?.detected, true);
  // Reason format is "same action repeated X/Y times in last N rounds"
  assert.match(r.loop!.reason, /5\/10/);
});

test("D142: missing actionSigs on any watched round → no loop (backward compat)", () => {
  // Pre-D142 sessions had aiState without actionSigs → no loop, no error.
  const history = [
    { intent: "fix" as const, prompt: "p1", aiState: { didWhat: "called edit_file", completed: false } },
    { intent: "fix" as const, prompt: "p2", aiState: { didWhat: "called edit_file", completed: false } },
    { intent: "fix" as const, prompt: "p3", aiState: { didWhat: "called edit_file", completed: false } },
    { intent: "fix" as const, prompt: "p4", aiState: { didWhat: "called edit_file", completed: false } },
    { intent: "fix" as const, prompt: "p5", aiState: { didWhat: "called edit_file", completed: false } },
  ];
  const r = classifyIntent("继续", history);
  assert.equal(r.loop?.detected ?? false, false, "no actionSigs means no loop");
});
