/**
 * Failure archive and distillation (D16).
 *
 * Repeated failures are a missing capability, not noise. This module turns the
 * failure rows the runtime already journals into deterministic guard drafts:
 * group the failures of the same kind of request, keep the vocabulary that keeps
 * showing up, and describe the guard in one line a human can check.
 *
 * Two rules keep this honest. First, nothing here calls a model — the same log
 * distills to the same draft, so a draft can be re-derived and audited. Second,
 * a draft carries no validation commands, which means `mintGene` refuses it:
 * distillation may propose a guard, but only the operator can supply the proof
 * that admits it to the library.
 */
import { geneAddress, type Gene, type GeneIntent } from "./gene.ts";
import type { FailureClass } from "./cycle.ts";

/** One round's failure, as journaled. Mechanical facts only — no error text. */
export interface FailureFact {
  readonly at: number;
  readonly intent: GeneIntent;
  /** The request's vocabulary, so a guard can match the same kind of ask. */
  readonly signals: readonly string[];
  readonly failureClass: FailureClass;
  readonly evidence: readonly string[];
  /** null when no gene was applied — the "nothing fit" gap is a failure too. */
  readonly address: string | null;
}

export interface GuardDraft {
  readonly key: string;
  /** Deterministic guard-only gene. Validation is deliberately empty. */
  readonly gene: Gene;
  readonly rounds: number;
  readonly failureClass: FailureClass;
  readonly signals: readonly string[];
  /** The mechanical facts the draft was read off. */
  readonly evidence: readonly string[];
  readonly summary: string;
}

/** How many rounds must share a pattern before it is worth a guard. */
export const DEFAULT_DISTILL_THRESHOLD = 3;

const CLASS_TEXT: Record<FailureClass, string> = {
  cancelled: "被取消",
  budget: "撞到预算上限",
  model: "模型侧失败",
  validation: "校验失败",
  unknown: "原因未知",
};

/**
 * Group failures by request kind and distill the recurring vocabulary into a
 * guard draft. A group with no signal reaching the threshold yields nothing:
 * a guard that can never be selected would be noise wearing a badge.
 */
export function distillGuards(
  facts: readonly FailureFact[],
  options: { threshold?: number } = {},
): GuardDraft[] {
  const threshold = options.threshold ?? DEFAULT_DISTILL_THRESHOLD;
  const groups = new Map<string, FailureFact[]>();
  for (const fact of facts) {
    const key = `${fact.intent}\u0000${fact.failureClass}`;
    const group = groups.get(key) ?? [];
    group.push(fact);
    groups.set(key, group);
  }

  const drafts: GuardDraft[] = [];
  for (const group of groups.values()) {
    if (group.length < threshold) continue;
    const counts = new Map<string, number>();
    for (const fact of group) {
      // Count each signal once per round: a request that repeats a word is still
      // one round of evidence.
      for (const signal of new Set(fact.signals)) counts.set(signal, (counts.get(signal) ?? 0) + 1);
    }
    const signals = [...counts.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([signal]) => signal)
      .sort();
    if (signals.length === 0) continue;

    const sample = group[0]!;
    const failureClass = sample.failureClass;
    const rounds = group.length;
    const evidence = [...new Set(group.flatMap((fact) => fact.evidence))].sort();
    const gene: Gene = {
      name: `guard-${sample.intent}-${failureClass}-${signals.join("-")}`.slice(0, 80),
      intent: sample.intent,
      signalsMatch: signals,
      preconditions: [],
      strategy: [{
        kind: "guard",
        text: `这是 ${sample.intent} 意图下反复${CLASS_TEXT[failureClass]}的场景（${rounds} 轮）：先确认前提与预算，再动手。`,
      }],
      // Deliberately empty: only the operator can supply the proof command that
      // admits this guard, which is what makes the admission gate real.
      constraints: { maxFiles: 1, maxLines: 20, forbiddenPaths: [] },
      validation: [],
      avoid: [`${CLASS_TEXT[failureClass]}：${evidence.join(", ")}`],
    };
    drafts.push({
      key: `${sample.intent}\u0000${failureClass}\u0000${signals.join(",")}`,
      gene,
      rounds,
      failureClass,
      signals,
      evidence,
      summary: `${sample.intent} / ${CLASS_TEXT[failureClass]} / ${rounds} 轮 / 信号 ${signals.join(", ")}`,
    });
  }
  return drafts.sort((a, b) => a.key.localeCompare(b.key));
}

/** The draft's identity, for showing the operator what would be minted. */
export function draftAddress(draft: GuardDraft): string {
  return geneAddress(draft.gene);
}

/**
 * Drop drafts the library already covers. Two genes of the same intent claiming
 * the same vocabulary are one capability; the archive should not keep proposing
 * a guard that already exists.
 */
export function unmintedDrafts(
  drafts: readonly GuardDraft[],
  genes: ReadonlyArray<{ gene: Gene }>,
): GuardDraft[] {
  const covered = new Set(genes.map(({ gene }) => `${gene.intent}\u0000${[...gene.signalsMatch].sort().join(",")}`));
  return drafts.filter((draft) => !covered.has(`${draft.gene.intent}\u0000${draft.signals.join(",")}`));
}
