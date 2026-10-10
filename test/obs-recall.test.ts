/**
 * Reading an omitted tool result back out of the session log (D52).
 *
 * The tests assert each rule the design rests on, and one of them is a
 * deliberate mutation: changing the placeholder so it no longer carries the
 * callId must make the test go red, because the placeholder's promise is its
 * only reason to exist.
 */
import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { omittedResultPlaceholder, projectOversizedToolResults, recallPage, RECALL_MAX_BYTES, RECALL_MAX_LINES } from "../src/obs-recall.ts";
import { DEFAULT_OBS_PROJECTION_THRESHOLD_BYTES } from "../src/runtime.ts";
import type { ChatMessage } from "../src/types.ts";
import { createObsRecallTool } from "../src/tools.ts";
import { SessionStore } from "../src/session-store.ts";
import { createTestFixture } from "./fixtures.ts";
import type { ToolContext } from "../src/tools.ts";

let fixture: Awaited<ReturnType<typeof createTestFixture>>;

before(async () => {
  fixture = await createTestFixture("obs-recall");
});

// The minimum ToolContext a session-bound read tool needs: the runtime would
// supply more (workspaceRoot, protectedRoots, ...), but `obs_recall` reads
// session state only and does not consult the environment. Built inside each
// test so the fixture's workspaceRoot is available (the test fixture resolves
// in `before`).
function noEnv(): ToolContext {
  return { workspaceRoot: fixture.workspaceRoot };
}

async function seedToolResult(sessionId: string, callId: string, content: string): Promise<void> {
  const store = new SessionStore({ root: fixture.storeRoot });
  await store.appendMessage(
    sessionId,
    { role: "tool", content, toolCallId: callId },
    { runId: "r0", step: 0, isError: false },
  );
}

describe("recallPage", () => {
  it("returns an empty page and eof for empty content", () => {
    const page = recallPage("");
    assert.equal(page.text, "");
    assert.equal(page.totalBytes, 0);
    assert.equal(page.totalLines, 0);
    assert.equal(page.eof, true);
    assert.equal(page.offset, 0);
    assert.equal(page.nextOffset, 0);
  });

  it("returns the whole content when it fits in a single page", () => {
    const content = "alpha\nbeta\ngamma\n";
    const page = recallPage(content);
    assert.equal(page.text, content);
    assert.equal(page.eof, true);
    assert.equal(page.nextOffset, Buffer.byteLength(content, "utf8"));
    assert.equal(page.totalLines, 4);
  });

  it("caps by bytes first when the content is one long line", () => {
    const content = "x".repeat(RECALL_MAX_BYTES * 2);
    const page = recallPage(content);
    assert.ok(Buffer.byteLength(page.text, "utf8") <= RECALL_MAX_BYTES, "byte cap holds");
    assert.equal(page.eof, false, "page is not the end");
    assert.equal(page.text.length, RECALL_MAX_BYTES, "one-byte chars: page text length equals cap");
  });

  it("caps by lines when a page hits RECALL_MAX_LINES first", () => {
    // Make each line short so the byte cap has plenty of room, and force the
    // line cap to bind by exceeding 400 lines.
    const line = "abc\n";
    const content = line.repeat(RECALL_MAX_LINES + 50);
    const page = recallPage(content);
    const newlines = (page.text.match(/\n/g) ?? []).length;
    assert.equal(newlines, RECALL_MAX_LINES, "page ends exactly at the Nth newline (whole line)");
    assert.equal(page.eof, false, "more lines remain");
  });

  it("never splits a UTF-8 character when an offset lands mid-character", () => {
    // Each "中" is 3 bytes; an offset of 1 is inside the first character.
    const content = "中".repeat(100);
    const page = recallPage(content, 1);
    assert.equal(page.offset, 3, "offset was advanced to the next character boundary");
    // The text must decode without replacement characters and must start with 中.
    assert.equal(page.text.charCodeAt(0), 0x4e2d, "first character is the start of 中");
    assert.equal(Buffer.byteLength(page.text, "utf8"), content.length * 3 - 3, "all but the skipped char is returned");
  });

  it("truncates the end of a page at a character boundary when the byte cap lands mid-char", () => {
    // 1 ASCII byte then enough 3-byte chars that the byte cap falls inside the last one.
    const ascii = "a";
    const tail = "中".repeat(7000); // ~21000 bytes
    const content = ascii + tail;
    const page = recallPage(content);
    assert.ok(Buffer.byteLength(page.text, "utf8") <= RECALL_MAX_BYTES, "byte cap holds");
    // The last byte must not be a UTF-8 continuation byte; otherwise the
    // page would be impossible to decode as a string.
    const last = Buffer.from(page.text, "utf8");
    assert.equal(last[last.length - 1]! & 0xc0, 0xc0 & last[last.length - 1]!, "trailing byte is not a continuation byte");
  });

  it("concatenation of every page equals the original (continuation invariant)", () => {
    // > 16 KiB so it must take more than one page.
    const content = "line one\nline two\n".repeat(2000);
    const collected: string[] = [];
    let offset = 0;
    let safety = 0;
    while (true) {
      const page = recallPage(content, offset);
      collected.push(page.text);
      if (page.eof) break;
      offset = page.nextOffset;
      if (++safety > 1000) throw new Error("runaway page loop");
    }
    assert.equal(collected.join(""), content, "every page together reproduces the original bytes");
  });

  it("throws on a non-integer or negative offset", () => {
    assert.throws(() => recallPage("x", 1.5), RangeError);
    assert.throws(() => recallPage("x", -1), RangeError);
    assert.throws(() => recallPage("x", Number.NaN), RangeError);
  });

  it("throws when the offset is past the end of the content", () => {
    assert.throws(() => recallPage("hello", 6), RangeError);
  });
});

describe("omittedResultPlaceholder", () => {
  it("names obs_recall and carries the callId, so the promise is retrievable", () => {
    const placeholder = omittedResultPlaceholder("call_abc", "hello world\nsecond line");
    // ⚠️ Mutation: drop the callId from the placeholder and this test goes red.
    // The promise IS the place; a placeholder that names a tool it does not
    // have is worse than a bare omission.
    assert.match(placeholder, /obs_recall/);
    assert.match(placeholder, /call_abc/);
  });

  it("is deterministic for the same content (so the same turn projects the same bytes)", () => {
    const a = omittedResultPlaceholder("call_abc", "x".repeat(10_000));
    const b = omittedResultPlaceholder("call_abc", "x".repeat(10_000));
    assert.equal(a, b);
  });

  it("reports the right size and line counts", () => {
    const content = "alpha\nbeta\ngamma\n";
    const placeholder = omittedResultPlaceholder("call_abc", content);
    assert.match(placeholder, new RegExp(`${Buffer.byteLength(content, "utf8")} bytes`));
    assert.match(placeholder, /4 lines/);
  });

  it("does NOT promise retrieval when no callId was recorded", () => {
    const placeholder = omittedResultPlaceholder(undefined, "x".repeat(100));
    assert.doesNotMatch(placeholder, /obs_recall/);
    assert.match(placeholder, /no call id was recorded/);
  });
});

describe("obs_recall tool", () => {
  it("reads a tool result back out of the session log byte-identically", async () => {
    const sessionId = "obs-recall-roundtrip";
    const content = "A".repeat(100) + "\n" + "B".repeat(100) + "\n";
    await seedToolResult(sessionId, "call_xyz", content);

    const tool = createObsRecallTool(new SessionStore({ root: fixture.storeRoot }), sessionId);
    const result = await tool.execute({ callId: "call_xyz" }, noEnv());
    assert.equal(result.isError, undefined);
    // The header line is bookkeeping; the body after the first newline is the page text.
    const body = result.content.split("\n").slice(1).join("\n");
    assert.equal(body, content, "the bytes that come back are exactly the bytes that went in");
  });

  it("paginates: a second call with the returned next_offset continues", async () => {
    const sessionId = "obs-recall-paginate";
    const content = "line\n".repeat(RECALL_MAX_LINES * 3);
    await seedToolResult(sessionId, "call_pag", content);

    const tool = createObsRecallTool(new SessionStore({ root: fixture.storeRoot }), sessionId);
    const pages: string[] = [];
    let nextOffset = 0;
    let safety = 0;
    while (true) {
      const call = await tool.execute({ callId: "call_pag", offset: nextOffset }, noEnv());
      pages.push(call.content.split("\n").slice(1).join("\n"));
      assert.match(call.content, /— end of result|next offset \d+/);
      if (/— end of result/.test(call.content)) break;
      nextOffset = Number(/next offset (\d+)/.exec(call.content)![1]);
      if (++safety > 10) throw new Error("runaway page loop");
    }
    assert.equal(pages.join(""), content, "every page together reproduces the original bytes");
  });

  it("rejects an unknown callId without throwing (clean failure, not a tool error)", async () => {
    const tool = createObsRecallTool(new SessionStore({ root: fixture.storeRoot }), "no-such-session");
    const result = await tool.execute({ callId: "call_does_not_exist" }, noEnv());
    assert.equal(result.isError, true);
    assert.match(result.content, /no tool result with callId/);
  });

  it("rejects a non-integer or negative offset without throwing", async () => {
    const sessionId = "obs-recall-bad-offset";
    await seedToolResult(sessionId, "call_a", "hello");
    const tool = createObsRecallTool(new SessionStore({ root: fixture.storeRoot }), sessionId);
    const a = await tool.execute({ callId: "call_a", offset: 1.5 }, noEnv());
    const b = await tool.execute({ callId: "call_a", offset: -1 }, noEnv());
    assert.equal(a.isError, true);
    assert.equal(b.isError, true);
  });

  it("returns the boundary page when offset equals the content size (empty + eof)", async () => {
    const sessionId = "obs-recall-eof";
    await seedToolResult(sessionId, "call_e", "abc");
    const tool = createObsRecallTool(new SessionStore({ root: fixture.storeRoot }), sessionId);
    const result = await tool.execute({ callId: "call_e", offset: Buffer.byteLength("abc", "utf8") }, noEnv());
    assert.match(result.content, /— end of result/);
    assert.equal(result.isError, undefined);
  });

  it("rejects an offset past the end of the result", async () => {
    const sessionId = "obs-recall-past-end";
    await seedToolResult(sessionId, "call_p", "abc");
    const tool = createObsRecallTool(new SessionStore({ root: fixture.storeRoot }), sessionId);
    const result = await tool.execute({ callId: "call_p", offset: 9999 }, noEnv());
    assert.equal(result.isError, true);
    assert.match(result.content, /past the end/);
  });
});

describe("projectOversizedToolResults", () => {
  const bigContent = "x".repeat(50_000);
  const smallContent = "x".repeat(100);
  const toolMessage = (content: string, callId = "call_x"): ChatMessage => ({ role: "tool", content, toolCallId: callId });

  it("projects a tool result whose content exceeds the threshold", () => {
    const messages: ChatMessage[] = [toolMessage(bigContent)];
    const out = projectOversizedToolResults(messages, 1024);
    assert.equal(out.length, 1);
    assert.notEqual(out[0]!.content, bigContent, "the original 50KB is gone");
    assert.match(out[0]!.content, /\[tool result omitted from this projection:/);
    assert.match(out[0]!.content, /50000 bytes/);
    assert.match(out[0]!.content, /obs_recall\(callId="call_x"\)/);
  });

  it("leaves a tool result below the threshold unchanged", () => {
    const messages: ChatMessage[] = [toolMessage(smallContent)];
    const out = projectOversizedToolResults(messages, 1024);
    assert.equal(out[0]!.content, smallContent);
  });

  it("leaves user and assistant messages alone even when they exceed the threshold", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: bigContent },
      { role: "assistant", content: bigContent },
    ];
    const out = projectOversizedToolResults(messages, 1024);
    assert.equal(out[0]!.content, bigContent);
    assert.equal(out[1]!.content, bigContent);
  });

  it("Infinity threshold is treated as 'off': returns a copy with no projections", () => {
    const messages: ChatMessage[] = [toolMessage(bigContent)];
    const out = projectOversizedToolResults(messages, Number.POSITIVE_INFINITY);
    assert.equal(out.length, 1);
    assert.equal(out[0]!.content, bigContent, "no projection happened");
    assert.notEqual(out, messages, "but a new array was returned, by contract");
  });

  it("threshold ≤ 0 is treated as 'off' (never 'project everything')", () => {
    const messages: ChatMessage[] = [toolMessage(bigContent)];
    assert.equal(projectOversizedToolResults(messages, 0)[0]!.content, bigContent);
    assert.equal(projectOversizedToolResults(messages, -1)[0]!.content, bigContent);
  });

  it("does not re-project a message that is already a placeholder (the order with compaction)", () => {
    // The post-compaction pass replaces large messages with placeholders. A
    // placeholder is small (well under any sensible threshold), so the
    // second pass should leave it alone. This is the test that proves the
    // helper does not describe a placeholder as if it were the original.
    const firstPass = projectOversizedToolResults([toolMessage(bigContent, "call_order")], 1024);
    const placeholder = firstPass[0]!;
    const secondPass = projectOversizedToolResults([placeholder], 1024);
    assert.equal(secondPass[0]!.content, placeholder.content, "no double-projection; the placeholder survives a second pass");
    assert.match(secondPass[0]!.content, /50000 bytes/, "the size it reports is still the ORIGINAL, not the placeholder's");
  });

  it("a tool message missing toolCallId is still replaced (placeholder says 'no call id was recorded')", () => {
    const messages: ChatMessage[] = [{ role: "tool", content: bigContent }];
    const out = projectOversizedToolResults(messages, 1024);
    assert.match(out[0]!.content, /no call id was recorded/);
  });

  it("preserves the order of messages", () => {
    const messages: ChatMessage[] = [
      { role: "user", content: "hello" },
      toolMessage(smallContent, "call_a"),
      toolMessage(bigContent, "call_b"),
      { role: "assistant", content: "thinking" },
      toolMessage(bigContent, "call_c"),
    ];
    const out = projectOversizedToolResults(messages, 1024);
    assert.equal(out.length, 5);
    assert.equal(out[0]!.role, "user");
    assert.equal(out[1]!.toolCallId, "call_a");
    assert.equal(out[1]!.content, smallContent);
    assert.equal(out[2]!.toolCallId, "call_b");
    assert.match(out[2]!.content, /\[tool result omitted/);
    assert.equal(out[3]!.role, "assistant");
    assert.equal(out[4]!.toolCallId, "call_c");
    assert.match(out[4]!.content, /\[tool result omitted/);
  });

  it("returns an empty array unchanged for empty input", () => {
    assert.deepEqual(projectOversizedToolResults([], 1024), []);
  });

  // D128 §九·六 (2026-10-09): the runtime's default threshold is no longer
  // "off" — it's `DEFAULT_OBS_PROJECTION_THRESHOLD_BYTES` (32 KiB), chosen
  // from a personal-agent test-suite n=11 measurement. These two tests pin
  // the default and the behavior at the boundary, so a refactor that
  // silently flips the default is caught.
  it("the runtime default threshold is exactly 32 KiB (= RECALL_MAX_BYTES × 2)", () => {
    assert.equal(DEFAULT_OBS_PROJECTION_THRESHOLD_BYTES, 32 * 1024);
    assert.equal(DEFAULT_OBS_PROJECTION_THRESHOLD_BYTES, RECALL_MAX_BYTES * 2);
  });

  it("at the default threshold, content at-or-below 32 KiB is not projected, content strictly above is", () => {
    const justUnder = "x".repeat(DEFAULT_OBS_PROJECTION_THRESHOLD_BYTES - 1);
    const exactly = "x".repeat(DEFAULT_OBS_PROJECTION_THRESHOLD_BYTES);
    const over = "x".repeat(DEFAULT_OBS_PROJECTION_THRESHOLD_BYTES + 1);

    const underOut = projectOversizedToolResults(
      [toolMessage(justUnder, "call_under")],
      DEFAULT_OBS_PROJECTION_THRESHOLD_BYTES,
    );
    assert.equal(underOut[0]!.content, justUnder, "one byte under the threshold passes through");

    const exactlyOut = projectOversizedToolResults(
      [toolMessage(exactly, "call_exact")],
      DEFAULT_OBS_PROJECTION_THRESHOLD_BYTES,
    );
    assert.equal(exactlyOut[0]!.content, exactly, "exactly at the threshold still passes through (the check is >, not ≥)");

    const overOut = projectOversizedToolResults(
      [toolMessage(over, "call_over")],
      DEFAULT_OBS_PROJECTION_THRESHOLD_BYTES,
    );
    assert.notEqual(overOut[0]!.content, over, "one byte over the threshold projects");
    assert.match(overOut[0]!.content, /tool result omitted/);
  });
});
