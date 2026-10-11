/**
 * Structured validation claims (D20).
 *
 * Until now `Gene.validation` was a list of strings that got rendered into the
 * prompt and never checked — "Prove it worked: npm.cmd test" was an instruction
 * to the model, not a claim the system evaluated. This module turns those
 * strings into claims that name an observable fact, and compares each claim
 * against what the round actually left behind.
 *
 * Three outcomes, and the third one is the point:
 *
 * - `met`          — the journal shows the fact the claim names.
 * - `unmet`        — the journal shows the round contradicted it.
 * - `unverifiable` — the record this round left behind cannot settle it. This is
 *                    recorded as itself. It is never counted as met, because that
 *                    would manufacture proof, and never as unmet, because that
 *                    would punish work that may well have been done. An honest
 *                    "we cannot tell" is a real outcome and the only reason this
 *                    module can be trusted at all.
 *
 * ⚠️ A `command` claim used to land in that third bucket unconditionally, on the
 * stated grounds that no command runner existed in this runtime. One does (D46),
 * so the claim is now decided against the round's own execution record — see
 * {@link checkCommandClaim} for exactly which cases the record settles and which
 * it still cannot.
 */
import type { ClaimOutcome, CommandRun, Gene, GeneValidation, RoundEvidence } from "./types.ts";

/**
 * ⚠️ D88: `RoundEvidence` and `ClaimOutcome` moved to `types.ts` and are re-exported
 * here. They moved for a specific reason rather than for tidiness: `task-state.ts`
 * needs both, for `AssessedStep` and `TaskStateAssessment`, which now live in
 * `types.ts` — so had they stayed here, `types.ts` would have had to import this
 * module, and since this module imports `Gene`/`GeneValidation` the graph would have
 * gained the cycle `types.ts → validation.ts → gene.ts → types.ts` (**the re-export
 * in `gene.ts` is a real import edge too**, which is easy to miss when reasoning
 * about cycles). Both are self-contained — `RoundEvidence` is two `readonly string[]`
 * fields and `ClaimOutcome` is three literals — so moving them cost nothing and
 * removed the only edge that could have closed a cycle.
 *
 * ⚠️ This module's type import is also repointed at `types.ts` instead of `gene.ts`,
 * which removes the `validation.ts → gene.ts` edge entirely: **type dependencies now
 * flow one way, into `types.ts`, and never between two implementation modules.**
 */
export type { ClaimOutcome, RoundEvidence } from "./types.ts";

export interface ClaimResult {
  readonly claim: GeneValidation;
  readonly outcome: ClaimOutcome;
  /** Why the outcome is what it is, in observable terms. */
  readonly detail: string;
}

export interface ValidationReport {
  readonly claims: readonly ClaimResult[];
  /** True when every claim is met. An unverifiable claim is not met. */
  readonly satisfied: boolean;
  /** Claims that could be decided and were contradicted. */
  readonly failed: readonly ClaimResult[];
}

/**
 * Compare one claim against the round's evidence.
 *
 * The comparison never guesses and never reads intent: each kind names one fact,
 * and the journal either shows it or does not.
 */
export function checkClaim(claim: GeneValidation, evidence: RoundEvidence): ClaimResult {
  switch (claim.kind) {
    case "files-written": {
      // Set equality, both directions: a claim that omits a file the round wrote
      // is as wrong as one that names a file it never touched — an understated
      // claim would otherwise pass by saying less.
      const claimed = [...new Set(claim.paths)].sort();
      const actual = [...new Set(evidence.filesWritten)].sort();
      const missing = claimed.filter((path) => !actual.includes(path));
      const extra = actual.filter((path) => !claimed.includes(path));
      if (missing.length === 0 && extra.length === 0) {
        return { claim, outcome: "met", detail: `wrote exactly ${claimed.join(", ") || "(nothing)"}` };
      }
      const parts: string[] = [];
      if (missing.length > 0) parts.push(`never wrote ${missing.join(", ")}`);
      if (extra.length > 0) parts.push(`also wrote ${extra.join(", ")}`);
      return { claim, outcome: "unmet", detail: parts.join("; ") };
    }
    case "no-write":
      return evidence.filesWritten.length === 0
        ? { claim, outcome: "met", detail: "no file was written" }
        : { claim, outcome: "unmet", detail: `wrote ${[...new Set(evidence.filesWritten)].join(", ")}` };
    case "tool-used": {
      if (!evidence.tools.includes(claim.tool)) {
        return { claim, outcome: "unmet", detail: `did not call ${claim.tool}` };
      }
      const times = evidence.tools.filter((tool) => tool === claim.tool).length;
      if (claim.times !== undefined && times < claim.times) {
        return { claim, outcome: "unmet", detail: `called ${claim.tool} ${times} time(s), claimed ${claim.times}` };
      }
      return { claim, outcome: "met", detail: `called ${claim.tool} ${times} time(s)` };
    }
    case "command":
      return checkCommandClaim(claim, evidence);
    default: {
      const unreachable: never = claim;
      return { claim: unreachable, outcome: "unverifiable", detail: "unknown claim kind" };
    }
  }
}

/**
 * Decide a command claim against the round's execution record.
 *
 * Which cases this settles, and which it refuses to, is the whole design:
 *
 * - **ran, exit code 0** — the proof the claim named is in the record: `met`.
 * - **ran, exit code non-zero** — the record contradicts the claim: `unmet`.
 *   This is the case that did not exist before, and the reason a claim about a
 *   command is worth making at all.
 * - **not run this round** — `unverifiable`, and no longer because a runner is
 *   missing. A round is not the whole task: the proof may have been shown in an
 *   earlier one, so "not seen here" is not "not done". Reading it as `unmet`
 *   would punish work that was done — the same defect, in the other direction,
 *   as reading it as `met`.
 * - **ran, no exit code recorded** — also `unverifiable`. A background job, a
 *   timeout and a cancellation all land here, and `null` must never be read as
 *   zero.
 *
 * A claim that is only whitespace matches every command by containment, so it is
 * refused as undecidable rather than reported as satisfied by accident.
 */
function checkCommandClaim(
  claim: { readonly kind: "command"; readonly command: string },
  evidence: RoundEvidence,
): ClaimResult {
  const wanted = normalizeCommand(claim.command);
  if (wanted === "") {
    return { claim, outcome: "unverifiable", detail: "the claim names no command, so there is nothing to look for" };
  }
  const runs = evidence.commands ?? [];
  // Last match wins: the most recent run is the state of the world, so a command
  // that passed and was then re-run and failed reads as failed.
  let match: CommandRun | undefined;
  for (const run of runs) {
    if (normalizeCommand(run.command).includes(wanted)) match = run;
  }
  if (match === undefined) {
    return {
      claim,
      outcome: "unverifiable",
      detail: `this round ran ${runs.length} command(s), none containing ${JSON.stringify(claim.command)}, cannot decide: ${claim.command}`,
    };
  }
  if (match.exitCode === null) {
    return {
      claim,
      outcome: "unverifiable",
      detail: `ran ${JSON.stringify(match.command)} but no exit code was recorded (background job, timeout or cancellation), cannot decide: ${claim.command}`,
    };
  }
  return match.exitCode === 0
    ? { claim, outcome: "met", detail: `ran ${JSON.stringify(match.command)}, exit code 0` }
    : { claim, outcome: "unmet", detail: `ran ${JSON.stringify(match.command)} and it exited ${match.exitCode}` };
}

/**
 * Whitespace-insensitive, so a claim written `npm.cmd test` matches a command
 * that ran as `cd personal-agent && npm.cmd  test`.
 *
 * Containment rather than equality, because a claim is usually a fragment of the
 * command that actually ran. Case is left alone — a different spelling is a
 * different command — and the detail reports the command that matched, so a wrong
 * match is visible rather than silent.
 */
function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, " ");
}

/** Compare every claim a gene declares. */
export function checkValidation(claims: readonly GeneValidation[], evidence: RoundEvidence): ValidationReport {
  const results = claims.map((claim) => checkClaim(claim, evidence));
  const failed = results.filter((result) => result.outcome === "unmet");
  return {
    claims: results,
    satisfied: results.length > 0 && results.every((result) => result.outcome === "met"),
    failed,
  };
}

/** The one-line-per-claim evidence strings the cycle journal stores. */
export function validationEvidence(report: ValidationReport): string[] {
  return report.claims.map((result) => `validation:${result.outcome}=${describeClaim(result.claim)} (${result.detail})`);
}

function describeClaim(claim: GeneValidation): string {
  switch (claim.kind) {
    case "files-written": return `files-written:${claim.paths.join(",")}`;
    case "no-write": return "no-write";
    case "tool-used": return `tool-used:${claim.tool}`;
    case "command": return `command:${claim.command}`;
  }
}

/**
 * Read a claim from a validation entry. A bare string is a command the operator
 * wrote by hand: it is kept verbatim and reported as unverifiable rather than
 * reinterpreted, because guessing what a human meant by "run the tests" is
 * exactly the kind of inference this project refuses.
 */
export function readClaim(entry: GeneValidation | string): GeneValidation {
  return typeof entry === "string" ? { kind: "command", command: entry } : entry;
}

/** A gene's declared claims, tolerating entries written before this existed. */
export function claimsOf(gene: Gene): GeneValidation[] {
  return gene.validation.map(readClaim);
}
