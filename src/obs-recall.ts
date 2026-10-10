/**
 * Reading an omitted tool result back out of the session log (D52).
 *
 * The mechanism is borrowed from SoL-Pi's `observation-pack` extension
 * (NVIDIA CORPORATION & AFFILIATES, MIT — `src/sol-pi/extensions/observation-pack/`,
 * `observation.ts` and `index.ts`). The borrow is deliberately **partial**, and
 * the two halves that were dropped are the interesting part.
 *
 * ⚠️ **No archive half.** SoL-Pi stores each large result in a content-addressed
 * file, projects an excerpt in its place, and reads the file back on demand. This
 * project already writes every tool result verbatim into the session log
 * (`runtime.ts` appends `result.content` unchanged, because ADR-0001 makes the
 * log the single source of truth). Copying the archive would therefore be a
 * second copy of data that already exists — exactly the shape ADR-0001 exists to
 * prevent. Recalling means *reading the log*, so this module writes nothing and
 * touches no filesystem. Dropping the archive also dropped its hazard: SoL-Pi
 * must defend a directory path-by-path because its recall tool builds a path out
 * of the id.
 *
 * ⚠️ **No id pattern.** SoL-Pi validates its id against `/^obs_[a-f0-9]{24}$/`
 * *before* constructing a path, which is load-bearing there and would be
 * ceremony here: this module builds no path from the id, so there is nothing for
 * a pattern to protect. `callId` is a lookup key into data the session already
 * owns, and it is matched exactly. Copying the regex would read as security
 * without being any.
 *
 * ⚠️ **What "original" means.** A tool caps its own output before returning
 * (`shell-tool.ts` appends `[output truncated at ...]`, and so do the inspection
 * and remote tools), so the log holds the tool's *capped* text. That is what
 * recall returns, and it is the right thing to return: it is what the model
 * actually saw. Promising the uncapped process output would be a lie about a
 * record the product never had.
 *
 * The chunking rules are SoL-Pi's, kept because each one is load-bearing rather
 * than decorative: the byte cap and the line cap apply **together** (a 16 KiB
 * single-line dump would otherwise be one unusable page), a page never splits a
 * UTF-8 sequence, and the finished page is re-verified against both caps instead
 * of being trusted to the arithmetic above it.
 */

/** Per-page ceiling, in bytes. Borrowed from SoL-Pi's `RECALL_MAX_BYTES`. */
export const RECALL_MAX_BYTES = 16 * 1024;
/** Per-page ceiling, in lines. Borrowed from SoL-Pi's `RECALL_MAX_LINES`. */
export const RECALL_MAX_LINES = 400;

import type { ChatMessage } from "./types.ts";

export interface RecallPage {
  readonly text: string;
  /** The byte offset this page really starts at; may exceed the one requested. */
  readonly offset: number;
  /** Pass back as `offset` to continue. Equals `offset` only for an empty page. */
  readonly nextOffset: number;
  readonly eof: boolean;
  readonly totalBytes: number;
  readonly totalLines: number;
}

/**
 * One page of a recorded tool result.
 *
 * Throws `RangeError` for an offset that is not a non-negative integer or that
 * lies past the end. Both are argument errors rather than content errors, and the
 * tool turns them into an ordinary failed tool result — the model asked for
 * something that does not exist, which is not a reason to fail the round.
 */
export function recallPage(content: string, requestedOffset = 0): RecallPage {
  const bytes = Buffer.from(content, "utf8");
  const totalBytes = bytes.length;
  if (!Number.isInteger(requestedOffset) || requestedOffset < 0) {
    return rangeError(`offset must be a non-negative integer, got ${requestedOffset}`);
  }
  if (requestedOffset > totalBytes) {
    return rangeError(`offset ${requestedOffset} is past the end of this result (${totalBytes} bytes)`);
  }

  // A page must begin on a character boundary. An offset landing inside a UTF-8
  // sequence is advanced to the next boundary rather than being decoded: the
  // caller gets fewer bytes than it asked for, never a replacement character.
  // (SoL-Pi reaches the same property from the other end, trimming the *trailing*
  // partial sequence; both ends need it, so this does both.)
  let start = requestedOffset;
  while (start < totalBytes && (bytes[start]! & 0xc0) === 0x80) start += 1;

  let end = Math.min(totalBytes, start + RECALL_MAX_BYTES);
  // Cut back to the last complete sequence when the byte cap landed mid-character.
  while (end > start && end < totalBytes && (bytes[end]! & 0xc0) === 0x80) end -= 1;

  // Whichever cap binds first. A page that stopped at the byte cap mid-line is
  // fine — `nextOffset` resumes there — so this only has to stop an unbounded
  // line count.
  let newlines = 0;
  for (let index = start; index < end; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    newlines += 1;
    if (newlines === RECALL_MAX_LINES) {
      end = index + 1;
      break;
    }
  }

  const text = bytes.toString("utf8", start, end);
  // Re-verified, not trusted. SoL-Pi performs the same check after building its
  // page, and it is the only assertion here that survives a later edit to the
  // loops above.
  const produced = Buffer.byteLength(text, "utf8");
  if (produced > RECALL_MAX_BYTES) {
    return rangeError(`recall page exceeded its hard limit (${produced} > ${RECALL_MAX_BYTES} bytes)`);
  }

  return {
    text,
    offset: start,
    nextOffset: end,
    eof: end >= totalBytes,
    totalBytes,
    // Zero for the empty string: a page count of one for nothing would be a
    // reading the model has to un-learn.
    totalLines: content === "" ? 0 : content.split("\n").length,
  };
}

function rangeError(message: string): never {
  throw new RangeError(message);
}

/**
 * What the model sees in place of an omitted tool result.
 *
 * ⚠️ **The wording is load-bearing, not cosmetic.** This slot used to read
 * `[tool result omitted; N chars remain in the session log]` — true, and useless.
 * Nothing could read those bytes back, so the note promised a retrieval that did
 * not exist: a dead pointer. That is worse than a bare omission, because the
 * model spends a step discovering it was told something false.
 *
 * `callId` is optional because a transcript replayed from before the id was
 * recorded has none. In that case the omission says so instead of naming a tool
 * that would refuse the call — the same rule as everywhere else here: an absent
 * identifier is not an invitation to guess one.
 */
export function omittedResultPlaceholder(callId: string | undefined, content: string): string {
  const bytes = Buffer.byteLength(content, "utf8");
  const lines = content === "" ? 0 : content.split("\n").length;
  const scale = `${bytes} bytes / ${lines} lines`;
  if (callId === undefined || callId === "") {
    return `[tool result omitted from this projection: ${scale}. It is intact in the session log, ` +
      `but no call id was recorded for it, so it cannot be read back.]`;
  }
  return `[tool result omitted from this projection: ${scale}. It is intact in the session log — ` +
    `read it back with obs_recall(callId=${JSON.stringify(callId)}); the result reports a next_offset ` +
    `to continue from when it does not fit in one page.]`;
}

/**
 * Replace oversized tool results in a prompt with an `obs_recall` placeholder
 * (D128 §九 — closes the §六 gap).
 *
 * **Fail-open.** A projection error keeps the original message in place.
 * `omittedResultPlaceholder` is total over strings, so a throw here is a
 * programming error, not a content error; the catch is a belt. The reason it
 * exists anyway: a failed projection must never cost the agent a piece of
 * context it could otherwise have read — the only thing worse than seeing a
 * placeholder for a result the model needs is *not* seeing the result at all
 * because a placeholder failed.
 *
 * **Off means "no projection", not "no copy".** A threshold of
 * `Number.POSITIVE_INFINITY` (or 0 / negative) returns a structural copy of
 * the input; callers cannot rely on referential identity to mean "no change".
 * One allocation per call against a session log that was just read in full
 * is not worth distinguishing.
 *
 * ⚠️ **Order with the post-compaction omission is load-bearing.** The
 * `buildPrompt` post-compaction pass already replaces some tool messages with
 * `omittedResultPlaceholder`. Running this projection *first* would replace a
 * large message with a small placeholder, and the compaction pass would then
 * call `omittedResultPlaceholder` on the *placeholder* itself, producing one
 * that describes the placeholder's bytes (≈200) instead of the original's
 * (potentially 50 KiB). Always run compaction first; this projection second.
 */
export function projectOversizedToolResults(
  messages: readonly ChatMessage[],
  thresholdBytes: number,
): ChatMessage[] {
  if (thresholdBytes === Number.POSITIVE_INFINITY || thresholdBytes <= 0) return messages.slice();
  return messages.map((message) => {
    if (message.role !== "tool") return message;
    if (Buffer.byteLength(message.content, "utf8") <= thresholdBytes) return message;
    try {
      return { ...message, content: omittedResultPlaceholder(message.toolCallId, message.content) };
    } catch {
      return message;
    }
  });
}
