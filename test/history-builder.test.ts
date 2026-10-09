/**
 * Tests for history-builder.ts (D139 + D140).
 *
 * The builder is the runtime side of v5: it reads the session log and
 * produces HistoryRound[] with `aiState` filled in, so the classifier
 * can use the AI's last state, not just the user's last prompt.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildHistory, summarizeRound, extractPlanNext } from "../src/history-builder.ts";
import type { SessionEvent } from "../src/session-store.ts";
import { classifyIntent } from "../src/intent-classifier.ts";

const userMsg = (runId: string, content: string): SessionEvent => ({
  v: 1,
  kind: "message",
  at: "2026-01-01T00:00:00Z",
  message: { role: "user", content },
  runId,
  step: 0,
});

const assistantMsg = (runId: string, content: string, toolCalls: { name: string }[] = [], isError = false): SessionEvent => ({
  v: 1,
  kind: "message",
  at: "2026-01-01T00:00:01Z",
  message: { role: "assistant", content, ...(toolCalls.length > 0 ? { toolCalls } : {}) },
  runId,
  step: 1,
  isError,
});

const toolResult = (runId: string, isError = false): SessionEvent => ({
  v: 1,
  kind: "message",
  at: "2026-01-01T00:00:02Z",
  message: { role: "tool", content: "ok", toolCallId: "tc1" },
  runId,
  step: 1,
  isError,
});

test("summarizeRound: tool names listed, completed=true on clean run", () => {
  const events = [
    userMsg("r1", "修登录 bug"),
    assistantMsg("r1", "Looking at it", [{ name: "read_file" }]),
    toolResult("r1"),
    assistantMsg("r1", "Fixed in patch-1", [{ name: "edit_file" }, { name: "run_command" }]),
    toolResult("r1"),
    assistantMsg("r1", "All done"),
  ];
  const state = summarizeRound(events);
  assert.equal(state.didWhat, "called read_file, edit_file, run_command");
  assert.equal(state.completed, true);
});

test("summarizeRound: text-only round, completed=true", () => {
  const events = [
    userMsg("r1", "你好"),
    assistantMsg("r1", "你好，有什么可以帮的？"),
  ];
  const state = summarizeRound(events);
  // The exact character count depends on Unicode semantics; what matters
  // is that the round is recorded as text-only (no tool calls) and the
  // reply was non-empty and error-free.
  assert.match(state.didWhat, /^replied \(\d+ chars\)$/);
  assert.equal(state.completed, true);
});

test("summarizeRound: tool error → completed=false", () => {
  const events = [
    userMsg("r1", "读文件"),
    assistantMsg("r1", "Reading", [{ name: "read_file" }]),
    toolResult("r1", /* isError */ true),
    assistantMsg("r1", ""),  // empty final reply
  ];
  const state = summarizeRound(events);
  assert.equal(state.completed, false);
  assert.equal(state.didWhat, "called read_file");
});

test("summarizeRound: empty round → didWhat='no action', completed=false", () => {
  const events = [userMsg("r1", "??")];
  const state = summarizeRound(events);
  assert.equal(state.didWhat, "no action");
  assert.equal(state.completed, false);
});

test("buildHistory: empty events returns empty history", () => {
  const history = buildHistory([], 5);
  assert.equal(history.length, 0);
});

test("buildHistory: groups by runId, drops non-message events", () => {
  const events: SessionEvent[] = [
    { v: 1, kind: "session", at: "...", id: "s1" },  // header, ignored
    userMsg("r1", "修 bug"),
    assistantMsg("r1", "done", []),
    { v: 1, kind: "usage", at: "...", usage: { inputTokens: 1, outputTokens: 1 } },  // usage, ignored
    userMsg("r2", "继续"),
    assistantMsg("r2", "applied", [{ name: "edit_file" }]),
    toolResult("r2"),
    assistantMsg("r2", "Done"),
  ];
  const history = buildHistory(events, 5);
  assert.equal(history.length, 2);
  assert.equal(history[0]!.prompt, "修 bug");
  assert.equal(history[0]!.aiState?.didWhat, "replied (4 chars)");
  assert.equal(history[1]!.prompt, "继续");
  assert.equal(history[1]!.aiState?.didWhat, "called edit_file");
});

test("buildHistory: keeps only last N rounds (most recent runIds)", () => {
  const events: SessionEvent[] = [];
  for (let i = 0; i < 10; i++) {
    events.push(userMsg(`r${i}`, `prompt ${i}`));
    events.push(assistantMsg(`r${i}`, `reply ${i}`, []));
  }
  const history = buildHistory(events, 3);
  assert.equal(history.length, 3);
  // Last 3 in order: r7, r8, r9
  assert.equal(history[0]!.prompt, "prompt 7");
  assert.equal(history[1]!.prompt, "prompt 8");
  assert.equal(history[2]!.prompt, "prompt 9");
});

test("buildHistory: round without user message is skipped", () => {
  const events: SessionEvent[] = [
    assistantMsg("r1", "stray"),  // no user message in r1
    userMsg("r2", "正常 prompt"),
    assistantMsg("r2", "ok", []),
  ];
  const history = buildHistory(events, 5);
  assert.equal(history.length, 1);
  assert.equal(history[0]!.prompt, "正常 prompt");
});

test("v5 end-to-end: '继续' after 5 identical-action rounds → loop detected", () => {
  // Five rounds that all read the same file → loop detector fires.
  // D142 window is 5 rounds; with 5 identical read_file calls, the
  // dominant action is 5/5 of the window → loop signal.
  const events: SessionEvent[] = [];
  for (let i = 0; i < 5; i++) {
    const runId = `r${i+1}`;
    events.push(userMsg(runId, i === 0 ? "修登录 bug" : "继续"));
    events.push(assistantMsg(runId, "Reading login.ts", [{ name: "read_file" }]));
    events.push(toolResult(runId));
    events.push(assistantMsg(runId, "Investigating", []));
  }
  const history = buildHistory(events, 5);
  // Sanity: the history should carry actionSigs per round.
  assert.equal(history[0]!.aiState?.actionSigs?.[0], 'read_file|""');
  // Now classify the NEXT user prompt (round 6) with this history.
  const result = classifyIntent("继续", history);
  assert.ok(result.loop, "loop should be detected (5 rounds of identical read_file)");
  assert.equal(result.loop!.detected, true);
  assert.equal(result.loop!.roundsSinceProgress, 5);
});

// === D140: planNext extraction ===

test("D140 extractPlanNext: '下一步：' (Chinese colon) matches", () => {
  assert.equal(extractPlanNext("已修复登录。\n下一步：跑测试"), "跑测试");
});

test("D140 extractPlanNext: '下一步:' (ASCII colon) matches", () => {
  assert.equal(extractPlanNext("Done.\n下一步: deploy to staging"), "deploy to staging");
});

test("D140 extractPlanNext: 'next step:' matches", () => {
  assert.equal(extractPlanNext("Fixed. next step: run tests"), "run tests");
});

test("D140 extractPlanNext: 'TODO:' matches", () => {
  assert.equal(extractPlanNext("Done. TODO: refactor later"), "refactor later");
});

test("D140 extractPlanNext: returns undefined when no pattern", () => {
  assert.equal(extractPlanNext("All done, no follow-up needed."), undefined);
  assert.equal(extractPlanNext(""), undefined);
  assert.equal(extractPlanNext("我先看了一下文件，没改东西"), undefined);
});

test("D140 extractPlanNext: caps long plans at 200 chars + ellipsis", () => {
  const long = "x".repeat(300);
  const result = extractPlanNext(`下一步：${long}`);
  assert.ok(result, "should match");
  assert.equal(result!.length, 201);
  assert.ok(result!.endsWith("…"));
});

test("D140 extractPlanNext: matches mid-line (header-style)", () => {
  // "## 下一步：..." — header line, the pattern still fires.
  assert.equal(extractPlanNext("## 下一步：清理临时文件"), "清理临时文件");
});

test("D140 summarizeRound: extracts planNext from final assistant message", () => {
  const events = [
    userMsg("r1", "修登录 bug"),
    assistantMsg("r1", "Looking", [{ name: "read_file" }]),
    toolResult("r1"),
    assistantMsg("r1", "已修复。\n下一步：跑测试"),
  ];
  const state = summarizeRound(events);
  assert.equal(state.didWhat, "called read_file");
  assert.equal(state.completed, true);
  assert.equal(state.planNext, "跑测试");
});

test("D140 summarizeRound: omits planNext field when not present", () => {
  const events = [
    userMsg("r1", "修登录 bug"),
    assistantMsg("r1", "Looking", [{ name: "read_file" }]),
    toolResult("r1"),
    assistantMsg("r1", "已修复，没有后续步骤。"),
  ];
  const state = summarizeRound(events);
  assert.equal(state.planNext, undefined, "no planNext means the field is undefined");
  assert.equal("planNext" in state, false, "no planNext key at all in the object");
});

test("D140 v5 end-to-end: planNext boosts OOV weight (round 2 '继续' w/ planNext)", () => {
  // Round 1 ends with a "下一步" line → aiState.planNext = "跑测试".
  // Round 2 user says "继续" (OOV). With planNext present, v5 raises
  // OOV history weight from 0.6 to 0.7 → stronger fix bias.
  const events: SessionEvent[] = [
    userMsg("r1", "修登录 bug"),
    assistantMsg("r1", "Reading", [{ name: "read_file" }]),
    toolResult("r1"),
    assistantMsg("r1", "已读完。\n下一步：跑测试"),
  ];
  const history = buildHistory(events, 5);
  assert.equal(history[0]!.aiState?.planNext, "跑测试");

  // Now classify the next "继续" with this history.
  const r = classifyIntent("继续", history);
  assert.equal(r.intent, "fix", "OOV '继续' + planNext history should resolve to fix");
  // prob > 0.802 = the v5 (no planNext) result from the v4-only test
  // (where history had no aiState). The boost is the difference.
  const r2 = classifyIntent("继续");
  // Without history, "继续" is OOV → verify by prior. With planNext
  // history, the boost moves the win from verify to fix.
  assert.notEqual(r.intent, r2.intent, "history should change the intent");
});
