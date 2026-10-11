/**
 * Structured validation claims (D20).
 *
 * Until now `Gene.validation` was a list of strings that got rendered into the
 * prompt and never checked — "Prove it worked: npm.cmd test" was an instruction
 * to the model, not a claim the system evaluated. This module turns those
 * strings into claims that name an observable fact, and compares each claim
 * against what the round actually left behind.
 *
 * Four outcomes. The last two are the point, and keeping them apart is what
 * makes the record usable:
 *
 * - `met`         — the journal shows the fact the claim names.
 * - `unmet`       — the journal shows the round contradicted it.
 * - `unchecked`   — a command exists whose execution would settle this claim and
 *                   the round did not run it. **A debt the round owes.**
 * - `undecidable` — no execution settles it: the claim names no command, or
 *                   names a kind this runtime does not understand. **A boundary.**
 *
 * Neither of the last two is ever counted as met, because that would manufacture
 * proof, and neither is ever counted as unmet, because that would punish work
 * that may well have been done. An honest "we cannot tell" is a real outcome and
 * the only reason this module can be trusted at all — but "we could have and did
 * not" is a different fact from "we could not", and an account that files them
 * together cannot say which of the two it is looking at.
 *
 * ⚠️ A `command` claim used to land in a single unverifiable bucket
 * unconditionally, on the stated grounds that no command runner existed in this
 * runtime. One does (D46), so the claim is now decided against the round's own
 * execution record — see {@link checkCommandClaim} for exactly which cases the
 * record settles and which it still cannot.
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
  /** True when every claim is met. An unchecked or undecidable claim is not met. */
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
      // `undecidable`, not `unchecked`: an unknown kind names no observable fact
      // at all, so there is no run that would settle it.
      return { claim: unreachable, outcome: "undecidable", detail: "unknown claim kind, so no execution could settle it" };
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
 * - **not run this round** — `unchecked`. The runner exists and the round used
 *   it, so running this one was reachable and was not reached. It is still not
 *   `unmet`: a round is not the whole task, and the proof may have been shown in
 *   an earlier one, so "not seen here" is not "not done". Reading it as `unmet`
 *   would punish work that was done — the same defect, in the other direction,
 *   as reading it as `met`.
 * - **ran, no exit code recorded** — also `unchecked`, not `undecidable`. A
 *   background job, a timeout and a cancellation all land here, and `null` must
 *   never be read as zero. It is a debt rather than a boundary because the fact
 *   is obtainable: running the command again, or waiting for the job, would
 *   settle it.
 *
 * A claim that is only whitespace is `undecidable` rather than `unchecked`:
 * there is no command whose execution would settle it, so nothing was skipped.
 * It would otherwise match every command by containment, which is exactly why it
 * has to be refused instead of reported as satisfied by accident.
 */
function checkCommandClaim(
  claim: { readonly kind: "command"; readonly command: string },
  evidence: RoundEvidence,
): ClaimResult {
  const wanted = normalizeCommand(claim.command);
  if (wanted === "") {
    return { claim, outcome: "undecidable", detail: "the claim names no command, so there is nothing to look for and nothing was skipped" };
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
      outcome: "unchecked",
      detail: `this round ran ${runs.length} command(s), none containing ${JSON.stringify(claim.command)}, so the proof was reachable and was not taken: ${claim.command}`,
    };
  }
  if (match.exitCode === null) {
    return {
      claim,
      outcome: "unchecked",
      detail: `ran ${JSON.stringify(match.command)} but no exit code was recorded (background job, timeout or cancellation); running it again would settle it: ${claim.command}`,
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
 * wrote by hand: it is kept verbatim and decided against the round's record like
 * any other command claim, rather than reinterpreted, because guessing what a
 * human meant by "run the tests" is exactly the kind of inference this project
 * refuses.
 */
export function readClaim(entry: GeneValidation | string): GeneValidation {
  return typeof entry === "string" ? { kind: "command", command: entry } : entry;
}

/** A gene's declared claims, tolerating entries written before this existed. */
export function claimsOf(gene: Gene): GeneValidation[] {
  return gene.validation.map(readClaim);
}
