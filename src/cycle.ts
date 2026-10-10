/**
 * The PDRI cycle: one explicit, replayable unit of work per send (D15).
 *
 * A cycle is what makes a round auditable: it names the phases the round went
 * through, holds the review verdict, and refuses illegal moves — a round whose
 * review failed cannot be marked complete, and a terminal cycle accepts nothing
 * further. State is derived by folding its event log, so a cycle is replayed
 * rather than trusted.
 *
 * Evidence chain: dsh-swarm core/cycle.ts (pure event transitions, terminal
 * phases irreversible, review gate before integration).
 */

import { isJournalPath, type BlastTier } from "./write-budget.ts";

export type CyclePhase =
  | "planned"
  | "executing"
  | "reviewing"
  | "integrating"
  | "completed"
  | "failed"
  | "cancelled";

const TERMINAL: readonly CyclePhase[] = ["completed", "failed", "cancelled"];

export function isTerminal(phase: CyclePhase): boolean {
  return TERMINAL.includes(phase);
}

/** How the round ended, from mechanical evidence only — never a self-report. */
export type EvaluationStatus = "success" | "partial" | "failed" | "blocked";

/** What went wrong, coarsely enough to be honest about the cause. */
export type FailureClass = "cancelled" | "budget" | "model" | "validation" | "unknown";

export interface CycleEvaluation {
  readonly status: EvaluationStatus;
  readonly failureClass: FailureClass | null;
  /** The facts this verdict was read off, verbatim. */
  readonly evidence: readonly string[];
  /** Who judged. Mechanical until a reviewer exists that is not the worker. */
  readonly reviewer: "mechanical";
}

export interface CycleState {
  readonly cycleId: string;
  readonly phase: CyclePhase;
  readonly startedAt: number;
  readonly updatedAt: number;
  /** Set by the review phase; null while the round is still running. */
  readonly evaluation: CycleEvaluation | null;
}

export type CycleEvent =
  | { readonly type: "execute-start"; readonly at: number }
  | { readonly type: "review-ready"; readonly at: number; readonly evaluation: CycleEvaluation }
  | { readonly type: "integrate-ready"; readonly at: number }
  | { readonly type: "complete"; readonly at: number }
  | { readonly type: "fail"; readonly at: number; readonly evaluation: CycleEvaluation };

export class CycleError extends Error {}

export function startCycle(cycleId: string, at: number): CycleState {
  if (cycleId.trim() === "") throw new CycleError("cycleId must be non-empty");
  return { cycleId, phase: "planned", startedAt: at, updatedAt: at, evaluation: null };
}

/**
 * Apply one event. Illegal transitions throw instead of being absorbed: a cycle
 * that silently skipped a phase would report a discipline it never had.
 */
export function applyEvent(state: CycleState, event: CycleEvent): CycleState {
  const at = event.at;
  if (isTerminal(state.phase)) {
    throw new CycleError(`cycle ${state.cycleId} is ${state.phase}; it accepts no further events`);
  }
  switch (event.type) {
    case "execute-start":
      expect(state, "planned", event.type);
      return { ...state, phase: "executing", updatedAt: at };
    case "review-ready":
      expect(state, "executing", event.type);
      return { ...state, phase: "reviewing", evaluation: event.evaluation, updatedAt: at };
    case "integrate-ready": {
      expect(state, "reviewing", event.type);
      // The review gate: a verdict that says the work failed or never started
      // must not be carried into integration as if it passed.
      const status = state.evaluation?.status;
      if (status === "failed" || status === "blocked") {
        throw new CycleError(`cycle ${state.cycleId} cannot integrate a ${status} review`);
      }
      return { ...state, phase: "integrating", updatedAt: at };
    }
    case "complete":
      expect(state, "integrating", event.type);
      return { ...state, phase: "completed", updatedAt: at };
    case "fail":
      // Reachable from every live phase, so an interrupted round still closes.
      return {
        ...state,
        phase: event.evaluation.failureClass === "cancelled" ? "cancelled" : "failed",
        evaluation: event.evaluation,
        updatedAt: at,
      };
    default:
      throw new CycleError(`unknown event ${(event as { type: string }).type}`);
  }
}

function expect(state: CycleState, phase: CyclePhase, event: string): void {
  if (state.phase !== phase) throw new CycleError(`cycle ${state.cycleId} is ${state.phase}, but ${event} requires ${phase}`);
}

/** Rebuild a cycle from its events. The log is the fact; this is the fold. */
export function replay(cycleId: string, startedAt: number, events: readonly CycleEvent[]): CycleState {
  return events.reduce<CycleState>((state, event) => applyEvent(state, event), startCycle(cycleId, startedAt));
}

export interface RunFacts {
  /** Model calls that returned a usable response. */
  readonly steps: number;
  readonly toolCalls: number;
  /** Tool results that came back as errors — including refused writes. */
  readonly toolErrors: number;
  /** Set when the round threw; null when it ran to a reply. */
  readonly failureClass: FailureClass | null;
  /** The final reply, when there was one. Used only for the shape veto below. */
  readonly reply?: string;
  /** The request this round answered, for the echo check. */
  readonly prompt?: string;
  /**
   * Writes this round's budget refused (D127).
   *
   * Recorded in the evidence and **never** allowed to move the verdict. A refusal
   * means the tool did not run — nothing broke — so treating it as a tool error
   * made the round `partial`, which charged the applied gene for a budget that
   * was sized wrong. The lesson "this strategy does not work" and the lesson
   * "this round was given too little room" are different, and only the first is
   * the gene's to answer for.
   */
  readonly budgetRefusals?: number;
  /**
   * Distinct paths this round's writes actually landed on.
   *
   * Read for one question only: did the round write anything outside its own
   * journal? Optional like `reply`, and for the same reason — a caller that did
   * not hand the ledger over is not claiming the round was hollow, so absent
   * data skips the check rather than firing it against an empty list.
   */
  readonly filesWritten?: readonly string[];
  /**
   * How far this round's blast radius got, relative to the number it declared
   * (D151).
   *
   * The declared number no longer refuses anything, so this is what makes it
   * cost something. `overrun` (1.3x and up, below the 1.5x hard stop) downgrades
   * a round that would otherwise be a clean success to `partial`: the work
   * happened, and it does not count as a clean win for the strategy that asked
   * for the number. Deliberately *not* `failed` — nothing broke, and calling an
   * oversized round a strategy failure is the same misattribution D127 removed
   * from the refusal axis.
   *
   * Optional like `reply`: a caller that did not hand the ledger over is not
   * claiming the round stayed inside its number.
   */
  readonly blastTier?: BlastTier;
}

/** A reply that opens by declining or reporting an inability, whatever follows. */
const OPENS_WITH_REFUSAL =
  /^\s*(抱歉|对不起|我没有|我需要(先)?(向您)?说明|无法|我不能|我这边没有|i (cannot|can't|am unable)|unable to|sorry)/i;

function isEchoOf(prompt: string, reply: string): boolean {
  const p = prompt.toLowerCase().replace(/\s+/g, " ").trim();
  const r = reply.toLowerCase().replace(/^echo:\s*/, "").replace(/\s+/g, " ").trim();
  return r.length > 0 && r.length <= p.length + 20 && p.includes(r);
}

/**
 * Shapes that disqualify a round from counting as a *success*, however tidy the
 * reply looks.
 *
 * These are not evidence to be weighed against other evidence — they are
 * disqualifying forms. A refusal written with headings and bullet points was
 * outscoring the refusal signal through the formatting alone when this was
 * tried as a weighted model, which is why the four below are vetoes rather than
 * weights.
 *
 * Calibrated against Jev's own judgment on 54 real rounds harvested from this
 * workspace (D125): the weighted 21-feature model reached 79.6% agreement with
 * Jev while breaking `evaluateRun`'s property that a genuine success is never
 * called a failure. These four rules reach 87.0% and keep that property
 * (fn=0), at zero network and zero model cost.
 *
 * Deliberately *not* here: "the work looked busy but used no tools". It reads
 * as a signal but did not separate the classes, and a rule that fires on
 * legitimate no-tool answers would cost more than it catches.
 */
export function roundVeto(facts: RunFacts): string | null {
  if (facts.steps === 0) return "no model turn produced a reply";
  // A round whose only writes were its own journal did no work, whatever the
  // reply says. This is a shape veto like the four below rather than a weight:
  // the journal is written on *every* round, so "wrote something" is not
  // evidence of work, and counting it as such is how a round that changed
  // nothing still reports success.
  //
  // Deliberately narrow. It fires only when *every* write landed in the journal,
  // so a round whose deliverable is a document is untouched, and one write
  // anywhere else clears it. Catching "one token file plus the journal" is the
  // validation commands' job, not this rule's — a path predicate cannot see
  // whether the work was real, and pretending otherwise would cost more in false
  // positives than it catches.
  //
  // Placed before the `reply === undefined` early return: whether the round did
  // any work does not depend on whether the caller handed over the reply.
  if (facts.filesWritten !== undefined && facts.filesWritten.length > 0
    && facts.filesWritten.every((path) => isJournalPath(path))) {
    return "wrote only the agent's own journal";
  }
  // Absent data is not evidence: a caller that did not hand over the reply is
  // not claiming the reply was bad, so the shape checks are skipped rather than
  // fired against an empty string.
  if (facts.reply === undefined) return null;
  const reply = facts.reply.trim();
  if (reply.length === 0) return "reply is empty";
  if (facts.prompt !== undefined && isEchoOf(facts.prompt, reply)) return "reply only echoes the request";
  if (OPENS_WITH_REFUSAL.test(reply)) return "reply opens by declining or reporting an inability";
  return null;
}

/**
 * Read a verdict off the facts. Nothing here consults the model's own claim of
 * success: a round counts as a success only when it produced a reply and no tool
 * failed. That is weaker than "the objective was met" and is named so.
 *
 * `roundVeto` narrows the top: a reply with a disqualifying shape is downgraded
 * to `partial`, never to `failed`, because something *was* produced — it just
 * does not amount to having done the work.
 */
export function evaluateRun(facts: RunFacts): CycleEvaluation {
  const evidence = [`steps=${facts.steps}`, `toolCalls=${facts.toolCalls}`, `toolErrors=${facts.toolErrors}`];
  // Appended rather than folded into `toolErrors`: the count is worth seeing, and
  // it is deliberately not an input to the status below. Absent when zero, so a
  // round under no budget pressure keeps the evidence it always had.
  if (facts.budgetRefusals) evidence.push(`budgetRefusals=${facts.budgetRefusals}`);
  // D151: the blast-radius ladder. Recorded whenever the round went past its
  // declared number — the reference implementation's own split, where an overrun
  // is labelled and only a larger one costs anything. `hard_stop` cannot be
  // reached by a round declaring 4 or more (the write that would reach it is
  // refused first), but it is a real tier at small declared values where the
  // absolute floor is what sets the stop.
  //
  // ⚠️ D152: the tier is recorded and **not** allowed to move the verdict. It used
  // to downgrade `success` to `partial`, which double-charged the same overrun —
  // the fold then counted it once as a lost success and again as a weighted one.
  // The cost belongs on the weight (`blastWeight`), which is a graded statement
  // about how much room the round spent; the verdict is a statement about whether
  // the round worked, and it did.
  if (facts.blastTier !== undefined && facts.blastTier !== "within") evidence.push(`blastRadius=${facts.blastTier}`);
  if (facts.failureClass !== null) {
    // A model that never produced anything usable means the round could not
    // start; the same holds for a budget refusal at step 0, which refused the
    // round before it began. Anything after a working call is a failure, not
    // a block.
    const blockedStart = (facts.failureClass === "model" || facts.failureClass === "budget") && facts.steps === 0;
    const status: EvaluationStatus = blockedStart ? "blocked" : "failed";
    return { status, failureClass: facts.failureClass, evidence, reviewer: "mechanical" };
  }
  const veto = roundVeto(facts);
  return {
    status: facts.toolErrors === 0 && veto === null ? "success" : "partial",
    failureClass: null,
    evidence: veto === null ? evidence : [...evidence, `veto=${veto}`],
    reviewer: "mechanical",
  };
}

/** Evidence lines rendered before the rest are counted rather than shown. */
const MAX_EVIDENCE_LINES = 8;

/**
 * Rendering of a round's mechanical verdict, for both CLI entry points — the
 * sibling of `formatBudget`.
 *
 * It exists because the verdict was otherwise invisible: `SendResult.evaluation`
 * carried it and the cycle journal stored it, but no terminal ever showed it. So
 * "trust only mechanical facts" held in the log and nowhere the operator looked,
 * which is the same defect D58 found in `enforceTaskSpec` — built, load-bearing,
 * reaching nobody.
 *
 * Gene claim outcomes need no renderer of their own. `validationEvidence` already
 * folds them into `evidence` as `validation:<outcome>=<claim> (<detail>)`, so this
 * one block covers both. Rendering `validation` separately would be a second
 * presentation of one fact, and the two would drift.
 *
 * Two honesty rules, both inherited from `formatBudget`:
 *
 * - Evidence the budget line already states (`steps=`, `toolCalls=`) is dropped.
 *   Not to save characters: repeating numbers the operator just read is noise, and
 *   noise is how a real warning gets ignored. `toolErrors=` is kept, because the
 *   budget line reports calls made, not calls that failed.
 * - Nothing is silently truncated. Past `MAX_EVIDENCE_LINES` the block says how
 *   many lines it withheld, since `evidence` grows with the gene's claim count and
 *   that count has no ceiling.
 *
 * `reviewer` is always printed. The field exists to say who judged —
 * "Mechanical until a reviewer exists that is not the worker" — so the day a
 * non-mechanical reviewer appears, this line is the only place the difference
 * would be visible.
 */
export function formatEvaluation(evaluation: CycleEvaluation): string {
  const head = `[本轮判定 ${evaluation.status} · 判定者 ${evaluation.reviewer}` +
    (evaluation.failureClass === null ? "" : ` · 原因 ${evaluation.failureClass}`) +
    "]";
  const kept = evaluation.evidence.filter((line) => !/^(steps|toolCalls)=/.test(line));
  const lines = kept.slice(0, MAX_EVIDENCE_LINES).map((line) => `  ${line}`);
  const omitted = kept.length - lines.length;
  if (omitted > 0) lines.push(`  … 另有 ${omitted} 条证据未显示`);
  return [head, ...lines].join("\n");
}
