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
 * it does not invent guard/verify steps.
 *
 * ⚠️ D155: it may now also carry a validation, and only when that validation can
 * be **transcribed** rather than invented — a command every round in the group
 * ran, exited zero, and which the archive has watched fail at least once. That
 * last condition is what separates a check from a badge: a command that can never
 * fail can never contradict the gene, so the gene could never be retired and the
 * library would only ever grow. When no such command exists the draft carries no
 * validation and `mintGene` refuses it — the honest outcome, not a gap.
 */
import { type Gene, type GeneIntent } from "./gene.ts";
import { COLD_START_BUDGET, measuredBudget, type WriteObservation } from "./write-budget.ts";
import type { CommandRun } from "./types.ts";

/** A successful round that applied no gene, as journaled. */
export interface SuccessFact extends WriteObservation {
  readonly at: number;
  readonly intent: GeneIntent;
  readonly signals: readonly string[];
  /** Tool names in call order. Empty when the round needed no tools. */
  readonly tools: readonly string[];
  /** Commands the round ran, with exit codes. Empty when it ran none. */
  readonly commands: readonly CommandRun[];
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

export const DERIVED_CAVEAT =
  "act 步骤只是转录事实证明用过的工具顺序；validation 同样是从这些轮次里**转录**的一条命令（每轮都跑过、退出码都是 0，且归档里见过它失败）。它证明的是「这条策略被照做了」，**不是**「这条策略是对的」——铸造前请自己判断这条命令是不是这项工作的真正证明。";

/**
 * The command this group can be validated by, or `null` when there is none.
 *
 * The rule is the strictest one that still yields anything, and each clause is
 * load-bearing: the command must appear in **every** round of the group (so it is
 * a fact about these rounds and not about one of them), must have exited zero in
 * each (so it is evidence *for* the strategy), and must be one the archive has
 * watched fail at least once (so the claim can be contradicted, which is what
 * keeps the gene mortal).
 */
function falsifiableCommand(
  group: readonly SuccessFact[],
  falsifiable: ReadonlySet<string>,
): string | null {
  const perRound = group.map(
    (fact) => new Set(fact.commands.filter((run) => run.exitCode === 0).map((run) => run.command)),
  );
  // A round that ran no successful command at all makes the whole group
  // unvalidatable: "every round ran it" cannot be true if one round did not.
  if (perRound.some((set) => set.size === 0)) return null;
  const common = [...perRound[0]!].filter((command) => perRound.every((set) => set.has(command)));
  return common.filter((command) => falsifiable.has(command)).sort()[0] ?? null;
}

/**
 * Group gene-less successes by intent and distill the recurring vocabulary into
 * candidate drafts. Rounds whose tool order differs are one profile: the
 * request kind is what the library would match on, not the exact call list.
 */
export function inductGenes(
  facts: readonly SuccessFact[],
  options: { threshold?: number; falsifiable?: ReadonlySet<string> } = {},
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
    // Transcribed from the group, or nothing. Never inferred: see `falsifiableCommand`.
    const command = falsifiableCommand(group, options.falsifiable ?? new Set());

    const acts: Gene["strategy"] = tools.length > 0
      ? tools.map((tool) => ({ kind: "act" as const, text: `调用 ${tool}` }))
      : [{ kind: "act", text: "无需工具的答复（转录里没有工具调用）" }];
    // `mintGene` requires a verify step beside any act. When a command was
    // transcribed this step is a transcription too — the round really did end by
    // running it — so the draft does not acquire an invented step merely because it
    // acquired a real one. When there is no command the draft stays as it was and
    // `mintGene` refuses it, which is the point rather than an oversight.
    const strategy: Gene["strategy"] = command === null
      ? acts
      : [...acts, { kind: "verify", text: `跑 ${command} 并确认退出码为 0` }];
    const gene: Gene = {
      name: `candidate-${intent}-${signals.join("-")}`.slice(0, 80),
      intent,
      signalsMatch: signals,
      preconditions: [],
      strategy,
      // Measured from the rounds in this group, not guessed (D127). This draft is
      // normally refused by `mintGene` anyway for carrying no validation — the
      // budget is sized here so that the operator who supplies the proof inherits
      // a figure taken from real rounds instead of a constant.
      // ponytail: forbiddenPaths:[] is also deliberate — the candidate cannot
      // know which paths are off-limits without a per-workspace decision. The
      // operator who mints this draft MUST supply forbiddenPaths at mint time;
      // an empty array would let the act step write anywhere (gene.ts:181
      // allowEmpty:true). Audit 2026-10-09 §2.3 closed the implicit gap by
      // making the contract explicit; the strict equivalent lives in
      // `distill.ts:106` and `CODE_MAP.md` runtime.ts row.
      constraints: { ...measuredBudget(group, COLD_START_BUDGET), forbiddenPaths: [] },
      validation: command === null ? [] : [{ kind: "command", command }],
      avoid: [],
    };
    drafts.push({
      key: `${intent}\u0000${signals.join(",")}`,
      gene,
      rounds: group.length,
      signals,
      tools,
      evidence,
      summary: `${intent} / ${group.length} 轮无基因成功 / 信号 ${signals.join(", ")} / 工具 ${tools.join(" → ") || "（无）"} / 验证 ${command ?? "（转录不到可被反驳的命令，草稿会被拒绝）"}`,
      caveat: command === null ? DEFAULT_CAVEAT : DERIVED_CAVEAT,
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
