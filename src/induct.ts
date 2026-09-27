/**
 * Success induction (D17).
 *
 * A successful round that applied no gene is a capability gap: the request was
 * handled, but the library had nothing to offer, so nothing was learned. This
 * module turns those rounds into candidate drafts.
 *
 * What it may claim is deliberately narrow. A transcript proves which tools were
 * called, in what order — it does not prove that "read first, then edit" is the
 * right discipline. Reading intent into a tool sequence is model narration, and
 * narration is exactly what makes distillation non-deterministic (D14/D16). So a
 * candidate records the request profile and the proven tool order, and says so;
 * it does not invent guard/verify steps, and it carries no validation, so
 * `mintGene` refuses it until the operator supplies real proof.
 */
import { type Gene, type GeneIntent } from "./gene.ts";

/** A successful round that applied no gene, as journaled. */
export interface SuccessFact {
  readonly at: number;
  readonly intent: GeneIntent;
  readonly signals: readonly string[];
  /** Tool names in call order. Empty when the round needed no tools. */
  readonly tools: readonly string[];
  readonly evidence: readonly string[];
}

export interface CandidateDraft {
  readonly key: string;
  readonly gene: Gene;
  readonly rounds: number;
  readonly signals: readonly string[];
  readonly tools: readonly string[];
  readonly evidence: readonly string[];
  readonly summary: string;
  /** What this draft does not claim, in the operator's own reading. */
  readonly caveat: string;
}

/** How many gene-less successes must share a profile before it is a gap. */
export const DEFAULT_INDUCT_THRESHOLD = 2;

export const DEFAULT_CAVEAT =
  "act 步骤只是转录事实证明用过的工具顺序；没有推断 guard/verify，也没有判断这个顺序好不好。铸造前请自己确认策略并补上 validation。";

/**
 * Group gene-less successes by intent and distill the recurring vocabulary into
 * candidate drafts. Rounds whose tool order differs are one profile: the
 * request kind is what the library would match on, not the exact call list.
 */
export function inductGenes(
  facts: readonly SuccessFact[],
  options: { threshold?: number } = {},
): CandidateDraft[] {
  const threshold = options.threshold ?? DEFAULT_INDUCT_THRESHOLD;
  const groups = new Map<GeneIntent, SuccessFact[]>();
  for (const fact of facts) {
    const group = groups.get(fact.intent) ?? [];
    group.push(fact);
    groups.set(fact.intent, group);
  }

  const drafts: CandidateDraft[] = [];
  for (const [intent, group] of groups) {
    if (group.length < threshold) continue;
    const counts = new Map<string, number>();
    for (const fact of group) {
      // Once per round: a request repeating a word is still one round of evidence.
      for (const signal of new Set(fact.signals)) counts.set(signal, (counts.get(signal) ?? 0) + 1);
    }
    const signals = [...counts.entries()]
      .filter(([, count]) => count >= threshold)
      .map(([signal]) => signal)
      .sort();
    if (signals.length === 0) continue;

    // The tool order the rounds actually used, longest run first, so the draft
    // shows the most complete proven sequence rather than an arbitrary one.
    const orders = group.map((fact) => fact.tools).filter((tools) => tools.length > 0);
    const tools = orders.length === 0 ? [] : [...orders].sort((a, b) => b.length - a.length || a.join(",").localeCompare(b.join(",")))[0]!;
    const evidence = [...new Set(group.flatMap((fact) => fact.evidence))].sort();

    const strategy: Gene["strategy"] = tools.length > 0
      ? tools.map((tool) => ({ kind: "act" as const, text: `调用 ${tool}` }))
      : [{ kind: "act", text: "无需工具的答复（转录里没有工具调用）" }];
    // `mintGene` requires a verify step beside any act, and this draft has none:
    // refusing the draft is the point, so the operator writes the real proof.
    const gene: Gene = {
      name: `candidate-${intent}-${signals.join("-")}`.slice(0, 80),
      intent,
      signalsMatch: signals,
      preconditions: [],
      strategy,
      constraints: { maxFiles: 1, maxLines: 20, forbiddenPaths: [] },
      validation: [],
      avoid: [],
    };
    drafts.push({
      key: `${intent}\u0000${signals.join(",")}`,
      gene,
      rounds: group.length,
      signals,
      tools,
      evidence,
      summary: `${intent} / ${group.length} 轮无基因成功 / 信号 ${signals.join(", ")} / 工具 ${tools.join(" → ") || "（无）"}`,
      caveat: DEFAULT_CAVEAT,
    });
  }
  return drafts.sort((a, b) => a.key.localeCompare(b.key));
}

/** Drop candidates the library already covers by (intent, signal set). */
export function uncoveredCandidates(
  drafts: readonly CandidateDraft[],
  genes: ReadonlyArray<{ gene: Gene }>,
): CandidateDraft[] {
  const covered = new Set(genes.map(({ gene }) => `${gene.intent}\u0000${[...gene.signalsMatch].sort().join(",")}`));
  return drafts.filter((draft) => !covered.has(`${draft.gene.intent}\u0000${draft.signals.join(",")}`));
}
