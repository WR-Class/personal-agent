/**
 * 丙 (D81): keep the byte-identity property, scope it correctly.
 *
 * Several tests pinned "the system text is byte-identical to the one before this
 * feature existed". That property is worth keeping — it is what proves a feature
 * did not quietly rewrite the product's own safety text. But D81 adds a
 * request-derived block, so the whole string is no longer identical.
 *
 * 丙 removes the new block explicitly instead of loosening the assertion: the
 * caller still compares against the exact pre-feature text. 甲 would have widened
 * the expectation (a loosening); 乙 would have dropped the intent fragment so the
 * block never appears (half the feature).
 *
 * ⚠️ Two things this pins, not one. `lastIndexOf` + slicing to the end proves the
 * block is appended last, which is the authority order recorded in `runtime.ts`:
 * product, then library, then operator, then task state, then this. Moving the
 * block earlier makes every caller of this helper fail, so a reorder cannot pass
 * silently. The block's own *content* is pinned separately — by
 * `taskspec-prompt.test.ts` and by the wiring tests in `taskspec.test.ts` — which
 * is why stripping by marker here does not weaken the suite.
 */
import assert from "node:assert/strict";

/** Where the request-derived block starts, once it has been appended. */
const BLOCK_MARKER = "\n\n本轮意图：";

/** The system text with this round's request-derived block removed. */
export function stripTaskPromptBlock(systemText: string): string {
  const at = systemText.lastIndexOf(BLOCK_MARKER);
  assert.ok(
    at >= 0,
    `system 文本末尾应当有本轮提示块（意图片段总是被组装出来，且必须排在最后）；实际结尾：${JSON.stringify(systemText.slice(-120))}`,
  );
  return systemText.slice(0, at);
}
