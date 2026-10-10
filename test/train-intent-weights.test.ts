/**
 * Tests for `train()` in `scripts/train-intent-weights.ts` (D130).
 *
 * The training function lives in a script, but its math is pure and small
 * enough to test in isolation. The tests pin the D130 invariant:
 *
 *   **1 row = 1 observation, regardless of how many signals the row produces.**
 *
 * A long Chinese prompt that splits into 30 bigrams must NOT add 30× the
 * row's prob vector to the per-bigram sums; it must add 1× the prob vector
 * across all 30 bigrams (1/30 per bigram). The total evidence the row adds
 * to the corpus is still 1 — the share is just a way to keep "long prompts
 * dominate" from happening by accident.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { train, type Row } from "../scripts/train-intent-weights.ts";
import { extractSignals } from "../src/taskspec.ts";

const FIXED_NOW = "2026-01-01T00:00:00.000Z";
const ALL_BUILD: Row["probs"] = { fix: 0, verify: 0, research: 0, operate: 0, build: 1 };
const ALL_FIX: Row["probs"] = { fix: 1, verify: 0, research: 0, operate: 0, build: 0 };

describe("train() (D130 — 1 row = 1 observation)", () => {
  it("a single-row training set produces priors equal to that row's probs", () => {
    const weights = train([{ text: "调研一下", gold: "research", probs: { fix: 0.1, verify: 0.2, research: 0.9, operate: 0.05, build: 0.05 } }], FIXED_NOW);
    assert.equal(weights.rows, 1);
    assert.equal(weights.priors.research, 0.9);
    assert.equal(weights.priors.fix, 0.1);
  });

  it("a long Chinese prompt does NOT inflate bigrams past 1.0 (D130 invariant)", () => {
    // 30-bigram build prompt (synthetic). Pre-D130, the per-bigram weight for
    // any bigram in this row would be build=1.0. Post-D130, share = 1/30 per
    // bigram, so bigram weights = build=1/30 ≈ 0.033.
    const longText = "在项目目录中创建新的工具方法实现一个功能完善的用户登录注册流程并支持邮箱验证";
    const extracted = extractSignals(longText);
    assert.ok(extracted.length >= 30, `expected ≥ 30 signals, got ${extracted.length}`);

    const weights = train([{ text: longText, gold: "build", probs: ALL_BUILD }], FIXED_NOW);
    // Every bigram should have build ≈ 1/N where N is the number of signals in the row
    // (D130 invariant: total evidence from the row = 1.0, distributed equally)
    for (const sig of extracted) {
      const row = weights.signals[sig];
      assert.ok(row, `signal ${sig} should be in the trained weights`);
      // The sum of all signal weight × share for this row = 1.0
      // So a single bigram's weight = (1/N). For N=30+, build weight should be < 0.1
      assert.ok(row.build < 0.1, `signal ${sig} should have build < 0.1 after D130 fix, got ${row.build}`);
    }
  });

  it("the sum of evidence from a row across all its signals equals 1 (evidence conservation)", () => {
    // Sum over all signals of (row_prob * share) = row_prob * 1 = row_prob.
    // For probs summing to 1 across intents, total evidence = 1 per row.
    const text = "在项目目录中创建新的工具方法";
    const extracted = extractSignals(text);
    assert.ok(extracted.length > 0);

    const weights = train([{ text, gold: "build", probs: { fix: 0.1, verify: 0.1, research: 0.1, operate: 0.1, build: 0.6 } }], FIXED_NOW);

    // The total prob contribution from this row, summed across every signal, should be
    // the row's probs. Verifying: for each intent, sum over all signals of (sums[signal][intent] / counts[signal])
    // — but since this is a 1-row corpus, counts[sig] = 1 for all extracted, so signals[sig][intent] = sums/1 = (probs × 1/N).
    // Sum over sig of probs×(1/N) = probs × 1.
    let buildSum = 0, fixSum = 0;
    for (const sig of extracted) {
      const row = weights.signals[sig];
      if (!row) continue;
      buildSum += row.build;
      fixSum += row.fix;
    }
    // Each sum = probs[i] × (extracted.length / extracted.length) = probs[i].
    // Allow a small epsilon for rounding.
    assert.ok(Math.abs(buildSum - 0.6) < 1e-9, `build sum should ≈ 0.6, got ${buildSum}`);
    assert.ok(Math.abs(fixSum - 0.1) < 1e-9, `fix sum should ≈ 0.1, got ${fixSum}`);
  });

  it("two rows with the same signals and same probs: each signal's weight is the row prob shared by the signal count (D130)", () => {
    // Pre-D130, two identical fix rows would each add probs.fix=1.0 to "bug"
    // and "fix" (2 signals), so signals["bug"].fix = (1+1)/2 = 1.0. Post-D130,
    // each row's prob is split across 2 signals, so each signal gets
    // 1.0 × 0.5 = 0.5 from each row, summed = 1.0, divided by count=2 = 0.5.
    // The D130 invariant: total evidence per row is preserved (1.0 = 0.5 + 0.5),
    // but no single signal can be inflated by the row's length.
    const weights = train([
      { text: "fix bug", gold: "fix", probs: ALL_FIX },
      { text: "fix bug", gold: "fix", probs: ALL_FIX },
    ], FIXED_NOW);
    const row = weights.signals["bug"];
    assert.ok(row, "bug signal should exist");
    assert.equal(row.fix, 0.5);
    assert.equal(weights.priors.fix, 1.0, "priors are 1 row = 1 observation, unchanged by D130");
  });

  it("shared signals across two intents: weight is the mean of the two rows' probs", () => {
    const weights = train([
      { text: "调研", gold: "research", probs: { fix: 0, verify: 0, research: 1, operate: 0, build: 0 } },
      { text: "调研", gold: "research", probs: { fix: 0.5, verify: 0, research: 0.5, operate: 0, build: 0 } },
    ], FIXED_NOW);
    const row = weights.signals["调研"];
    assert.ok(row, "调研 signal should exist");
    // Row 1 contributes 1/N × {0,0,1,0,0} for the N signals of "调研".
    // Row 2 contributes 1/N × {0.5,0,0.5,0,0}.
    // For "调研" as a single signal (length 2 ≤ 4 → whole-token also added),
    // count = 2, sums add up across both rows: research = 1 + 0.5 = 1.5 (each × share=1)
    // weight.research = 1.5 / 2 = 0.75
    // (Other intents: fix = (0 + 0.5) / 2 = 0.25)
    assert.ok(Math.abs(row.research - 0.75) < 1e-9, `research ≈ 0.75, got ${row.research}`);
    assert.ok(Math.abs(row.fix - 0.25) < 1e-9, `fix ≈ 0.25, got ${row.fix}`);
  });

  it("empty training set produces empty weights with safe priors (1.0 for 0 rows = no division by zero)", () => {
    const weights = train([], FIXED_NOW);
    assert.equal(weights.rows, 0);
    assert.equal(weights.priors.fix, 0);
    assert.deepEqual(weights.signals, {});
  });
});
