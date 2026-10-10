/**
 * Tests for the parse helpers in `scripts/multi-model-eval.ts`.
 *
 * The provider adapters (`callJev`/`callOpenAI`) need network to be useful;
 * the only thing that doesn't is `parseProbsFromText` — the noisy-text
 * extractor that pulls a 5-prob JSON object out of an LLM response that may
 * include prose, markdown fences, or partial JSON. That extractor is the
 * gateway between a non-Jev model's text output and the same Probs shape Jev
 * gives us directly, so its behavior decides whether the cross-model
 * comparison is meaningful.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { parseProbsFromText } from "../scripts/multi-model-eval.ts";

describe("parseProbsFromText (D131)", () => {
  it("parses a clean JSON line", () => {
    const got = parseProbsFromText('{"fix":0.1,"verify":0.2,"research":0.9,"operate":0.05,"build":0.15}');
    assert.equal(got.fix, 0.1);
    assert.equal(got.verify, 0.2);
    assert.equal(got.research, 0.9);
    assert.equal(got.operate, 0.05);
    assert.equal(got.build, 0.15);
  });

  it("tolerates prose around the JSON (prefix)", () => {
    const got = parseProbsFromText('Sure! Here are the probabilities: {"fix":0.05,"verify":0.10,"research":0.92,"operate":0.04,"build":0.18}');
    assert.equal(got.research, 0.92);
  });

  it("tolerates markdown fences around the JSON", () => {
    const got = parseProbsFromText('```json\n{"fix":0.05,"verify":0.10,"research":0.92,"operate":0.04,"build":0.18}\n```');
    assert.equal(got.research, 0.92);
  });

  it("clamps values > 1 to 1", () => {
    const got = parseProbsFromText('{"fix":1.5,"verify":0.10,"research":0.92,"operate":0.04,"build":-0.05}');
    assert.equal(got.fix, 1.0, "1.5 must clamp to 1");
    assert.equal(got.build, 0, "-0.05 must clamp to 0");
  });

  it("falls back to loose regex extraction if JSON parse fails", () => {
    const got = parseProbsFromText('fix: 0.5, verify: 0.2, research: 0.8, operate: 0.1, build: 0.4');
    assert.equal(got.fix, 0.5);
    assert.equal(got.research, 0.8);
    assert.equal(got.build, 0.4);
  });

  it("returns zeros for missing intents", () => {
    const got = parseProbsFromText('{"fix":0.5,"verify":0.2}');
    assert.equal(got.research, 0);
    assert.equal(got.operate, 0);
    assert.equal(got.build, 0);
  });

  it("returns zeros when nothing is parseable", () => {
    const got = parseProbsFromText("I cannot provide probabilities.");
    assert.equal(got.fix + got.verify + got.research + got.operate + got.build, 0);
  });
});
