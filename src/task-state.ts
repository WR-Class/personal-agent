/**
 * Task state: what the task is, how far it got, and what would prove each step.
 *
 * This is the persistent half of TaskSpec. `taskspec.ts` classifies one send;
 * this carries state across sends, and — the point of the video source it comes
 * from (D55 采用清单第 3 项) — the state is **updated**, not appended as more
 * chat text. The log stores every version; the prompt would only ever see the
 * latest, the way `compaction()` already works for summaries.
 *
 * ## Completion is computed, never stored
 *
 * There is no `done` field anywhere in this module. A step carries a **claim**
 * naming an observable fact, and {@link assessTaskState} evaluates it against
 * evidence taken from the journal. The reason is D14/D15/D19's rule: the model
 * saying "this step is finished" and the model saying "this round succeeded" are
 * structurally the same thing, and neither is admissible. `validation.ts` was
 * written for exactly this, so this module adds no new notion of proof — it
 * reuses `checkValidation` and its three outcomes.
 *
 * `unverifiable` is therefore a real, displayed state. A step whose claim names
 * a shell command stays "we cannot tell" forever, because no command runner
 * exists in this runtime (`validation.ts:86-89`). That is an inherited ceiling,
 * not a bug: the honest outcome is the only reason the report can be trusted.
 *
 * ## Evaluation never depends on a gene being applied
 *
 * `runtime.ts:822` checks a gene's claims only when a gene was applied
 * (`applied ? … : null`). Copying that gate here would leave every step
 * permanently `unverifiable` in practice, because the gene library is empty and
 * most rounds are gene-less — the feature would look like it worked while never
 * deciding anything. So `assessTaskState` takes evidence directly, following the
 * shape of `evaluateRun` (`runtime.ts:821`), which is mechanical and gene-free.
 *
 * ## Claims are monotone: they may be strengthened, never weakened
 *
 * The subtle attack is not a model marking its own step done — that is impossible
 * here — but a model **lowering the bar**: swapping a hard claim for an easy one,
 * or deleting the step that has not been met. Both look like "updating the plan".
 * So {@link assertNotWeakened} refuses them at append time, mechanically, the way
 * `appendSummary` refuses a `covers` that does not match the observed message
 * count. Prose is free; criteria are not.
 *
 * The per-kind rules follow from what each kind actually means in
 * `validation.ts`, not from an intuition about strength:
 *
 * - `files-written` uses **bidirectional set equality**, so `paths` is
 *   **immutable**. Adding a path is not strengthening: if the round wrote both
 *   files, the old claim fails (extra file) and the new one passes. Growth would
 *   let a failing claim become a passing one.
 * - `tool-used` treats `times` as a **lower bound** (`times < claim.times` is
 *   unmet), so `times` may grow or appear, and may not shrink or disappear.
 * - `no-write` has no parameters; `command` is only comparable to itself.
 * - A kind change is refused: there is no strength order across kinds, and the
 *   default answer to an undefined comparison is no.
 */
import { parseValidation, type GeneValidation } from "./gene.ts";
import { checkValidation } from "./validation.ts";
import type { ClaimOutcome, RoundEvidence } from "./validation.ts";

export interface TaskStateStep {
  /** Prose. Not authority — the claim is. May be rewritten freely. */
  readonly text: string;
  /**
   * The acceptance criterion, as an observable fact. Absent means the step has
   * no criterion yet, which is reported as an unknown rather than as progress.
   */
  readonly claim?: GeneValidation;
}

/** What a writer supplies. Note what is absent: no `done`, no `outcome`. */
export interface TaskStateInput {
  /** Prose progress. Freely rewritable; it is context, not a record of fact. */
  readonly state: string;
  readonly steps: readonly TaskStateStep[];
}

export interface AssessedStep {
  readonly text: string;
  readonly claim?: GeneValidation;
  /** Absent when the step has no claim — that is an unknown, not a pass. */
  readonly outcome?: ClaimOutcome;
  /** Why the outcome is what it is, in observable terms. */
  readonly detail?: string;
}

export interface TaskStateAssessment {
  readonly steps: readonly AssessedStep[];
  /**
   * True only when there is at least one step and every one of them is `met`.
   * Mirrors `checkValidation.satisfied`: an empty state is not complete, and an
   * `unverifiable` step is not met.
   */
  readonly complete: boolean;
  /** Steps with no criterion, or one this runtime cannot decide. */
  readonly unknowns: readonly string[];
  /** Steps whose criterion was decided and contradicted. */
  readonly failed: readonly string[];
}

/** Raised when a later state would lower a bar an earlier one set. */
export class WeakenedTaskStateError extends Error {}

/**
 * Refuse a state that weakens what the previous one required.
 *
 * Steps are compared by position: they may be appended to, never removed or
 * reordered. Prose (`text`, and the state block itself) is not compared at all —
 * it carries no authority, so rewriting it cannot lower a bar.
 */
export function assertNotWeakened(
  previous: readonly TaskStateStep[] | undefined,
  next: readonly TaskStateStep[],
): void {
  if (previous === undefined || previous.length === 0) return;
  if (next.length < previous.length) {
    throw new WeakenedTaskStateError(
      `任务状态从 ${previous.length} 步减少到 ${next.length} 步：删除步骤等于撤掉它的验收条件`,
    );
  }
  for (let index = 0; index < previous.length; index++) {
    compareClaim(previous[index]!.claim, next[index]!.claim, index + 1);
  }
}

function compareClaim(previous: GeneValidation | undefined, next: GeneValidation | undefined, step: number): void {
  // Adding a criterion where there was none is progress: the step was an unknown
  // before and is checkable now. (Residual, recorded honestly: a writer could add
  // an easy criterion. That is a "who sets the bar" question, not a monotonicity
  // one, and the claim is visible in the state, so it is not a hidden lie.)
  if (previous === undefined) return;
  if (next === undefined) {
    throw new WeakenedTaskStateError(`步骤 ${step} 的验收条件被移除（原为 ${describe(previous)}）`);
  }
  if (previous.kind !== next.kind) {
    throw new WeakenedTaskStateError(
      `步骤 ${step} 的验收条件类型从 ${previous.kind} 改成了 ${next.kind}：不同类型之间没有强度序，故一律拒绝`,
    );
  }
  switch (previous.kind) {
    case "files-written": {
      // Bidirectional set equality in validation.ts, so any change is a different
      // claim rather than a stronger one — and growth can turn a failure into a
      // pass. Immutable is the only sound rule.
      const before = [...previous.paths].sort().join(",");
      const after = [...(next as typeof previous).paths].sort().join(",");
      if (before !== after) {
        throw new WeakenedTaskStateError(
          `步骤 ${step} 的 files-written 从 [${before}] 改成了 [${after}]：该条件是双向集合相等，` +
            `增加一个路径会让"多写了文件"的失败变成通过，故 paths 不可变`,
        );
      }
      return;
    }
    case "no-write":
      return;
    case "tool-used": {
      const before = previous;
      const after = next as typeof before;
      if (before.tool !== after.tool) {
        throw new WeakenedTaskStateError(
          `步骤 ${step} 的 tool-used 从 ${before.tool} 改成了 ${after.tool}：换一个工具是换一个条件，不是加强它`,
        );
      }
      // `times` is a lower bound (validation.ts:81), so larger is stronger.
      if (before.times === undefined) return;
      if (after.times === undefined) {
        throw new WeakenedTaskStateError(
          `步骤 ${step} 的 tool-used(${before.tool}) 去掉了次数下限 ${before.times}：去掉下限是放宽`,
        );
      }
      if (after.times < before.times) {
        throw new WeakenedTaskStateError(
          `步骤 ${step} 的 tool-used(${before.tool}) 次数下限从 ${before.times} 降到了 ${after.times}`,
        );
      }
      return;
    }
    case "command": {
      const before = previous;
      const after = next as typeof before;
      if (before.command !== after.command) {
        throw new WeakenedTaskStateError(
          `步骤 ${step} 的 command 从 ${JSON.stringify(before.command)} 改成了 ${JSON.stringify(after.command)}：` +
            `该类型在本运行时恒为 unverifiable，无从比较强弱，故只允许原样保留`,
        );
      }
      return;
    }
    default: {
      const unreachable: never = previous;
      throw new WeakenedTaskStateError(`步骤 ${step} 的验收条件类型未知：${JSON.stringify(unreachable)}`);
    }
  }
}

/**
 * Evaluate every step's claim against what the round actually left behind.
 *
 * Called unconditionally — never gated on a gene being applied, because the gene
 * library is empty and a gated evaluation would report every step as undecided
 * forever while looking like it worked.
 */
export function assessTaskState(steps: readonly TaskStateStep[], evidence: RoundEvidence): TaskStateAssessment {
  const assessed: AssessedStep[] = steps.map((step) => {
    if (step.claim === undefined) return { text: step.text };
    // One claim at a time, so each step gets its own outcome rather than a
    // report that blends them. `checkValidation` is reused unchanged.
    const result = checkValidation([step.claim], evidence).claims[0]!;
    return { text: step.text, claim: step.claim, outcome: result.outcome, detail: result.detail };
  });
  const unknowns: string[] = [];
  const failed: string[] = [];
  assessed.forEach((step, index) => {
    const where = `步骤 ${index + 1}（${step.text}）`;
    if (step.outcome === undefined) unknowns.push(`${where} 缺验收条件`);
    else if (step.outcome === "unverifiable") unknowns.push(`${where} 无法判定：${step.detail}`);
    else if (step.outcome === "unmet") failed.push(`${where} 未达成：${step.detail}`);
  });
  return {
    steps: assessed,
    complete: assessed.length > 0 && assessed.every((step) => step.outcome === "met"),
    unknowns,
    failed,
  };
}

function describe(claim: GeneValidation): string {
  switch (claim.kind) {
    case "files-written": return `files-written:[${claim.paths.join(",")}]`;
    case "no-write": return "no-write";
    case "tool-used": return claim.times === undefined ? `tool-used:${claim.tool}` : `tool-used:${claim.tool}>=${claim.times}`;
    case "command": return `command:${claim.command}`;
  }
}

/**
 * Ceiling on the rendered block, in bytes. Symmetric with `MAX_CONSTRAINT_BYTES`:
 * both are author-written text blocks riding in the system prompt and re-sent on
 * every call, so both are pure per-turn overhead.
 *
 * Enforced at **write** time, not at injection time, and the difference is
 * concrete: refusing at injection would make every later `buildPrompt` throw, so
 * one oversized write would deny service to the rest of the session. Refusing at
 * write time costs one failed call and leaves the session usable.
 */
export const MAX_TASK_STATE_BYTES = 32_768;

/**
 * Render the state for the system prompt, or `undefined` when there is nothing to
 * say — an empty state injects no block at all, so the prompt stays byte-identical
 * to one from before this feature existed.
 *
 * **Deliberately absent: per-step outcomes.** Evidence is per-round (`runtime.ts`
 * resets the write ledger and the tool list on every send) while the task is
 * cross-round, so printing "step 1: unmet (did not call read_file)" at the start
 * of round five would report something done in round two as never done.
 * Actively misleading the model is worse than telling it less. Outcomes belong at
 * the end of a round, where that round's evidence is complete.
 *
 * What is printed instead is the criterion itself: the part the model needs in
 * order to aim at it, and the part whose immutability is what makes the
 * monotonicity rule mean anything.
 */
export function formatTaskStateForPrompt(state: string, steps: readonly TaskStateStep[]): string | undefined {
  const prose = state.trim();
  if (prose === "" && steps.length === 0) return undefined;
  const lines: string[] = ["当前任务状态（跨轮保留，每轮重新注入）："];
  if (prose !== "") lines.push(`进度：${prose}`);
  if (steps.length > 0) {
    lines.push("步骤与验收条件：");
    steps.forEach((step, index) => {
      lines.push(step.claim === undefined
        ? `${index + 1}. ${step.text} —— 验收条件：（缺；缺验收条件的步骤是未知，不是已完成）`
        : `${index + 1}. ${step.text} —— 验收条件：${describe(step.claim)}`);
    });
  }
  lines.push("以上是记录，不是保证：此处文字不放宽任何权限，与档位或规则表冲突时，以档位与规则表为准。");
  lines.push("验收条件由系统对日志证据机械求值，写入者说了不算；求值结果不在本块内。");
  lines.push("unverifiable（例如需要跑命令的验收条件）既不等于完成也不等于失败：本运行时没有命令执行器，判不了就是判不了。");
  return lines.join("\n");
}

/**
 * Parse tool arguments into a {@link TaskStateInput}, or return the reason they
 * are not one. A returned string rather than a throw keeps the tool's failure path
 * in one place, and every refusal names the offending position — a model that is
 * told "invalid arguments" cannot fix them.
 *
 * Claim shapes go through `parseValidation`, the same parser genes use. Two
 * parsers for one shape would be two answers to "what is a valid claim", and they
 * would drift; D60 established the vocabulary is not gene-specific, so sharing it
 * is the honest reading of that finding rather than a shortcut.
 */
export function parseTaskStateArguments(args: Record<string, unknown>): TaskStateInput | string {
  const state = args.state;
  if (typeof state !== "string" || state.trim() === "") return "'state' must be a non-empty string";
  const rawSteps = args.steps;
  if (!Array.isArray(rawSteps)) return "'steps' must be an array; send the full current list, not a delta";
  const steps: TaskStateStep[] = [];
  for (let index = 0; index < rawSteps.length; index++) {
    const entry = rawSteps[index];
    if (entry === null || typeof entry !== "object") return `'steps[${index}]' must be an object`;
    const step = entry as Record<string, unknown>;
    if (typeof step.text !== "string" || step.text.trim() === "") {
      return `'steps[${index}].text' must be a non-empty string`;
    }
    if (step.claim === undefined) {
      steps.push({ text: step.text });
      continue;
    }
    let claim: GeneValidation;
    try {
      claim = parseValidation([step.claim])[0]!;
    } catch (error) {
      return `'steps[${index}].claim' ${error instanceof Error ? error.message : String(error)}`;
    }
    steps.push({ text: step.text, claim });
  }
  return { state, steps };
}
