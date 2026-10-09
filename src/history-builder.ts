/**
 * Build classifier history from a session's events (D139 + D140).
 *
 * The classifier (intent-classifier.ts) consumes `HistoryRound[]` whose
 * `aiState` field carries an end-of-round summary. v5 uses planNext and
 * the loop detector; D139 filled the two structural fields (`didWhat` +
 * `completed`), D140 adds the third: `planNext`, parsed from the AI's
 * last message when it contains a "next step" line. The `userAccepted`
 * field stays defaulted to `undefined` — that needs a different signal
 * (user push-back) and is the D141 candidate.
 *
 * Storage: nothing is added. The session log already records every
 * message, every tool call, and every error flag — `summarizeRound`
 * walks one runId's events and derives the summary on demand. A round
 * that ended without a usable final assistant message is reported as
 * `completed: false` so the loop detector has honest input to compare.
 */
import type { HistoryRound, AIState } from "./intent-classifier.ts";
import { classifyIntent } from "./intent-classifier.ts";
import type { SessionEvent } from "./session-store.ts";

/**
 * Group the session's message events by runId (each user send is a
 * runId), keep the last `lastN` rounds in order, and turn each one
 * into a HistoryRound. The intent is re-classified from the stored
 * user prompt — a pure function, so the result is stable across reads
 * and is the same number the runtime would have computed at the time.
 */
export function buildHistory(
  events: ReadonlyArray<SessionEvent>,
  lastN: number = 5,
): HistoryRound[] {
  // ponytail: group by runId with a Map to keep insertion order; the
  // JSONL log has events in chronological order, so insertion order is
  // round order. Skipping non-message events keeps the grouping tight.
  const rounds = new Map<string, SessionEvent[]>();
  for (const e of events) {
    if (e.kind !== "message") continue;
    if (!e.runId) continue;
    const arr = rounds.get(e.runId) ?? [];
    arr.push(e);
    rounds.set(e.runId, arr);
  }

  const allRoundIds = [...rounds.keys()];
  const recent = allRoundIds.slice(Math.max(0, allRoundIds.length - lastN));
  const history: HistoryRound[] = [];
  for (const runId of recent) {
    const roundEvents = rounds.get(runId);
    if (!roundEvents) continue;
    const userMsg = roundEvents.find((e) => e.kind === "message" && e.message.role === "user");
    if (!userMsg || userMsg.kind !== "message") continue;
    const prompt = userMsg.message.content;
    const aiState = summarizeRound(roundEvents);
    const intent = classifyIntent(prompt).intent;
    history.push({ intent, prompt, aiState });
  }
  return history;
}

// ponytail: lines that read like "the AI is about to do X". Match is
// lenient (lowercase, leading whitespace allowed) and is anchored on
// the keyword, not the start of the line, so headers like
// "## 下一步：..." still match. The colon and the line that follows it
// is the plan; lines without a colon are kept verbatim.
const PLAN_NEXT_PATTERNS: ReadonlyArray<RegExp> = [
  /下一步[：:]\s*(.+)/i,
  /\bnext\s*step[s]?[：:]\s*(.+)/i,
  /\bTODO[：:]\s*(.+)/i,
  /\bnext[：:]\s*(.+)/i,
];

/**
 * Extract a one-line "next step" plan from the AI's final message.
 * Returns undefined when no pattern matches: the classifier treats
 * `planNext === undefined` the same as a missing field, and the OOV
 * weight stays at 0.6 instead of 0.7. This is the D140 hook: it works
 * without an AI prompt change, because a non-trivial share of AI
 * replies already end with a "下一步" / "next" / "TODO" line.
 */
export function extractPlanNext(text: string): string | undefined {
  if (text.length === 0) return undefined;
  const lines = text.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    for (const re of PLAN_NEXT_PATTERNS) {
      const m = trimmed.match(re);
      if (m && m[1]) {
        const plan = m[1].trim();
        // Cap to a reasonable sentence length so a runaway match (e.g.
        // a paragraph that mentions "下一步" as a side note) does not
        // produce a 1000-character planNext that the user never wrote.
        return plan.length > 200 ? plan.slice(0, 200) + "…" : plan;
      }
    }
  }
  return undefined;
}

/**
 * Reduce one round's events to the four fields v5 can act on without
 * a network call. `didWhat` lists the unique tool names the round
 * called (or a fallback string for text-only rounds). `completed` is
 * true when the round produced a final assistant message and no
 * message in the round carries an error flag — a cheap, mechanical
 * check that mirrors what the cycle evaluation reports. `planNext`
 * is parsed from the final assistant message; absent there, the field
 * is `undefined` and the v5 classifier falls back to the no-planNext
 * weight (0.6 for OOV instead of 0.7). `actionSigs` is the per-tool-call
 * fingerprint list that D142's loop detector consumes.
 */
export function summarizeRound(events: ReadonlyArray<SessionEvent>): AIState {
  const toolNames: string[] = [];
  const actionSigs: string[] = [];
  let lastAssistantText = "";
  let anyError = false;

  for (const e of events) {
    if (e.kind !== "message") continue;
    if (e.message.role === "assistant") {
      lastAssistantText = e.message.content;
      for (const tc of e.message.toolCalls ?? []) {
        if (tc.name) {
          toolNames.push(tc.name);
          // ponytail: signature is name + the args the tool actually saw.
          // Same tool on the same file with the same patch → same sig;
          // different patch → different sig. The args are JSON-encoded
          // already by the runtime, so a simple join is the right shape.
          const args = (tc as { arguments?: unknown }).arguments;
          const argsStr = typeof args === "string" ? args : JSON.stringify(args ?? "");
          actionSigs.push(`${tc.name}|${argsStr}`);
        }
      }
      if (e.isError) anyError = true;
    } else if (e.message.role === "tool") {
      if (e.isError) anyError = true;
    }
  }

  const uniqueTools = [...new Set(toolNames)];
  let didWhat: string;
  if (uniqueTools.length > 0) {
    didWhat = `called ${uniqueTools.join(", ")}`;
  } else if (lastAssistantText.length > 0) {
    didWhat = `replied (${lastAssistantText.length} chars)`;
  } else {
    didWhat = "no action";
  }

  // ponytail: a tool-error or empty final reply is a "no" — the loop
  // detector treats an empty actionSigs array as "AI did nothing", which
  // makes a text-only round look identical to a no-op round. That is the
  // intended signal: a round that did nothing is the same as a loop.
  const completed = lastAssistantText.length > 0 && !anyError;
  const planNext = extractPlanNext(lastAssistantText);
  const base = { didWhat, completed, actionSigs };
  return planNext !== undefined ? { ...base, planNext } : base;
}
