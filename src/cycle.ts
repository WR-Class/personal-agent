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
}

/**
 * Read a verdict off the facts. Nothing here consults the model's own claim of
 * success: a round counts as a success only when it produced a reply and no tool
 * failed. That is weaker than "the objective was met" and is named so.
 */
export function evaluateRun(facts: RunFacts): CycleEvaluation {
  const evidence = [`steps=${facts.steps}`, `toolCalls=${facts.toolCalls}`, `toolErrors=${facts.toolErrors}`];
  if (facts.failureClass !== null) {
    // A model that never produced anything usable means the round could not
    // start; anything after a working call is a failure, not a block.
    const status: EvaluationStatus = facts.failureClass === "model" && facts.steps === 0 ? "blocked" : "failed";
    return { status, failureClass: facts.failureClass, evidence, reviewer: "mechanical" };
  }
  return {
    status: facts.toolErrors === 0 ? "success" : "partial",
    failureClass: null,
    evidence,
    reviewer: "mechanical",
  };
}
