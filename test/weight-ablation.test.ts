/**
 * Offline ablation of the selection weights (D109).
 *
 * Shape from EvoMap's `ablateKautoLambda`, which reports `rankChangesByLambda`,
 * `selectedChangesByLambda` and `topKChangesByLambda` — mutation testing applied to
 * a scoring weight. The discipline it encodes is the point: a factor that changes no
 * ranking should not ship, and a change that moves many selections needs measured
 * evidence rather than an argument.
 *
 * ⚠️ The data is synthesized, and that is the weak link in this measurement rather
 * than a detail. This product's own `genes.jsonl` holds one gene line (248 B,
 * measured in D105), so an ablation over it would prove nothing; the plugin's log
 * holds 63 but is a different schema this store cannot read. Every conclusion here is
 * therefore conditional on the constructed library being representative.
 *
 * ⚠️ The first version of this file was written to prove a claim from D107 — that at
 * `signalWeight: 1` vocabulary beats a verified record — and the claim did not
 * survive contact with `gene.ts:229`. Overlap is `matched / gene.signalsMatch.length`
 * , normalized by the GENE's own breadth rather than by the request or by a union. So
 * a one-signal gene that matches scores 1.0 and a three-signal gene that matches all
 * three also scores 1.0: they tie on vocabulary and reliability decides, at any
 * weight ratio. The library that was supposed to show the ratio mattering made it
 * unobservable, and the ablation moved zero ranks. Two findings came out of that
 * instead of the one expected:
 *
 *   1. **The ratio is only observable between genes of different breadth.** Narrow
 *      genes are structurally favoured on the overlap term — a gene listing one
 *      common signal can never lose on vocabulary, while one listing ten signals of
 *      which three match scores 0.3. That property was undocumented and is now pinned
 *      by the second test below.
 *   2. **The `signalWeight: 0.4` this round set out to justify does not actually
 *      invert the ordering.** Measured below: 0.4 leaves the loud gene winning, and
 *      the crossover is at or below 0.25. Proposing 0.4 because EvoMap caps
 *      signals_match near 0.04 would have been copying a number rather than a
 *      reason — which is the same defect D109 found in the existing 1:1.
 *
 * ⚠️ So this file asserts directions and the existence of a crossover, not counts.
 * Counts over a synthetic library would be read as measurements of the product; a
 * direction survives the synthesis being wrong.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_SELECTION_POLICY, mintGene, scoreCandidates } from "../src/gene.ts";
import type { GeneDraft, GeneExpression, SelectionPolicy } from "../src/types.ts";

const NOW = 1_700_000_000_000;

function draft(name: string, signalsMatch: readonly string[]): GeneDraft {
  return {
    name,
    intent: "build",
    signalsMatch,
    preconditions: ["目标文件已读"],
    strategy: [
      { kind: "guard", text: "读取整个目标文件" },
      { kind: "act", text: "用 edit 做定点替换" },
      { kind: "verify", text: "跑测试" },
    ],
    constraints: { maxFiles: 1, maxLines: 40, forbiddenPaths: [] },
    validation: ["npm.cmd run build"],
    avoid: ["不要整文件重写"],
  };
}

/**
 * The library the ratio is observable in.
 *
 * `narrow` lists one signal, matches it fully (overlap 1.0) and has a mediocre
 * record. `broad` lists six, matches three (overlap 0.5) and has a better one. Both
 * pass the hard gates — same intent, non-zero overlap, no failure streak — so nothing
 * but the weights separates them. `excluded` is the control: no vocabulary overlap at
 * all, so it is dropped before any weight is consulted, and a weight change that
 * resurrected it would mean the gates had stopped running first.
 *
 * ⚠️ The records are deliberately close (6/10 against 8/10). A wide gap lets
 * reliability win at any ratio and makes the ablation unobservable — exactly the
 * mistake the first version of this file made.
 */
const CASES = [
  { name: "narrow", signals: ["snippet"], expression: { attempts: 10, successes: 6, lastSuccessAt: NOW - 1000, streak: 0 } as GeneExpression },
  { name: "broad", signals: ["snippet", "编辑", "replace", "重构", "测试", "文档"], expression: { attempts: 10, successes: 8, lastSuccessAt: NOW - 1000, streak: 0 } as GeneExpression },
  { name: "excluded", signals: ["kubernetes"], expression: { attempts: 10, successes: 10, lastSuccessAt: NOW - 1000, streak: 0 } as GeneExpression },
];

const REQUEST = { intent: "build" as const, signals: ["snippet", "编辑", "replace"], text: "用 snippet 替换并编辑" };

function candidates() {
  return CASES.map((item) => {
    const minted = mintGene(draft(item.name, item.signals));
    return { address: minted.address, gene: minted.gene, expression: item.expression };
  });
}

/** Rank the non-excluded candidates under one weight vector. */
function rank(policy: SelectionPolicy): string[] {
  return scoreCandidates(candidates(), REQUEST, policy, NOW)
    .filter((candidate) => candidate.excluded === null)
    .sort((a, b) => b.score - a.score || a.address.localeCompare(b.address))
    .map((candidate) => candidate.gene.name);
}

describe("weight ablation", () => {
  it("overlap is normalized by the gene's own breadth, which favours narrow genes", () => {
    // The property the failed first attempt exposed. Pinned because it is load-
    // bearing for every weight decision: if overlap were a union-based ratio the
    // numbers below would all move, and nobody reading gene.ts:229 would know that a
    // one-signal gene cannot lose on vocabulary.
    const scored = scoreCandidates(candidates(), REQUEST, DEFAULT_SELECTION_POLICY, NOW);
    const byName = new Map(scored.map((candidate) => [candidate.gene.name, candidate]));
    assert.equal(byName.get("narrow")?.overlap, 1, "一个信号全中 ⇒ 重叠度 1.0");
    assert.equal(byName.get("broad")?.overlap, 0.5, "六个信号中三个 ⇒ 重叠度 0.5，尽管它匹配的词更多");
    assert.equal(byName.get("excluded")?.excluded, "no signal overlap", "控制组必须在打分之前就被排除");
  });

  it("at today's 1:1 the narrow gene with the worse record still wins", () => {
    // This is the defect D109 set out to test, now in a library where it is actually
    // observable. Vocabulary at 1.0 against 0.5 outweighs a record of 6/10 against
    // 8/10 — a gene wins for listing fewer words, not for working better.
    assert.equal(rank(DEFAULT_SELECTION_POLICY)[0], "narrow", "现状：词汇重叠压过已验证的记录");
  });

  it("the crossover is at or below 0.25, so the 0.4 this round proposed was unjustified", () => {
    // ⚠️ The load-bearing result. Lowering signalWeight to 0.4 — chosen because
    // EvoMap treats signals_match as weak evidence — does NOT invert the ordering, so
    // shipping it would have changed a number while changing no decision, and the
    // version string would have advertised a reranking that never happened.
    const at04 = rank({ ...DEFAULT_SELECTION_POLICY, signalWeight: 0.4 });
    assert.equal(at04[0], "narrow", "0.4 不足以翻转：这次改动会动不了任何排序");
    const at025 = rank({ ...DEFAULT_SELECTION_POLICY, signalWeight: 0.25 });
    assert.equal(at025[0], "broad", "0.25 或更低才真的让已验证的记录压过词汇");
    // Reliability is left at 1 rather than raised, so the change under test is
    // exactly one number. Raising reliability AND lowering signal would move the
    // crossover for two reasons at once and the ablation could not attribute it.
  });

  it("the hard gates run before the weights, so no ratio can resurrect an excluded gene", () => {
    // Checked across the whole ablated range: an ablation that only compared two
    // orderings would miss a weight change quietly turning the gates off. This is the
    // property D107 adopted from EvoMap, where even a forced gene id cannot override
    // trust/review/ban.
    for (const signalWeight of [1, 0.4, 0.25, 0]) {
      const policy: SelectionPolicy = { ...DEFAULT_SELECTION_POLICY, signalWeight };
      const scored = scoreCandidates(candidates(), REQUEST, policy, NOW);
      const excluded = scored.find((candidate) => candidate.gene.name === "excluded");
      assert.ok(excluded !== undefined && excluded.excluded !== null, `signalWeight=${signalWeight} 时零重叠仍须被排除`);
      assert.ok(!rank(policy).includes("excluded"));
    }
  });

  it("rewards knowing less: the same single hit scores lower on a broader gene", () => {
    // The sharpest form of the asymmetry pinned above, and the reason it is worth a
    // test of its own rather than a sentence in a comment. Two genes each match
    // exactly one request signal — identical evidence about this request — and the
    // one that also declares four other situations it applies in is scored lower for
    // having declared them. The incentive that creates is to write narrow
    // `signalsMatch` lists, which makes genes apply in more places than they were
    // validated for. That is the opposite of what the field is for.
    const narrow = mintGene(draft("same-hit-narrow", ["snippet"]));
    const broad = mintGene(draft("same-hit-broad", ["snippet", "重构", "部署", "回滚", "监控"]));
    const scored = scoreCandidates(
      [
        { address: narrow.address, gene: narrow.gene, expression: { attempts: 10, successes: 8, lastSuccessAt: NOW - 1000, streak: 0 } as GeneExpression },
        { address: broad.address, gene: broad.gene, expression: { attempts: 10, successes: 8, lastSuccessAt: NOW - 1000, streak: 0 } as GeneExpression },
      ],
      { intent: "build" as const, signals: ["snippet"], text: "改一下 snippet" },
      DEFAULT_SELECTION_POLICY,
      NOW,
    );
    const byName = new Map(scored.map((c) => [c.gene.name, c]));
    assert.equal(byName.get("same-hit-narrow")?.overlap, 1);
    assert.equal(byName.get("same-hit-broad")?.overlap, 0.2, "多声明的四个信号变成分母");
    // ⚠️ Identical records, identical hits, identical recency — so the score
    // difference is entirely the breadth penalty, which is what makes this a
    // measurement of the metric rather than of the weights.
    assert.equal(byName.get("same-hit-narrow")?.reliability, byName.get("same-hit-broad")?.reliability);
    assert.ok(
      (byName.get("same-hit-narrow")?.score ?? 0) > (byName.get("same-hit-broad")?.score ?? 0),
      "同样只命中一个信号，声明得更少的那条反而分更高 —— 这就是那个反向激励",
    );
  });

  it("recency stays the weakest term, because it decays confidence and not the record", () => {
    // gene.ts:186 already states the semantics; this pins the ordering that follows
    // from them. Raising recency above reliability would let a gene that succeeded
    // once recently outrank one that has succeeded eight times — the record being
    // overwritten by the calendar.
    for (const signalWeight of [1, 0.25]) {
      const policy: SelectionPolicy = { ...DEFAULT_SELECTION_POLICY, signalWeight };
      assert.ok(policy.recencyWeight < policy.reliabilityWeight, "recency 必须仍是最弱的一项");
    }
  });
});
