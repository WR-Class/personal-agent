/**
 * Extract user-text prompts from DSH session_projcache (D128 §十).
 *
 * DSH persists session-level state in `~/.dsh/storages/session_projcache/sessions/<uuid>.json`
 * as a CRDT-shaped `record.rows` map. Four row keys carry user text:
 *
 *   title        → string (project / session title)
 *   titleInput   → { first: { text: string }, count, lastSeq } (first user input)
 *   goal         → { current: { goal: { objective: string, ... } } } (current goal)
 *   turnOutline  → { turns: [{ turn, seq, prompt, response }, ...] } (per-turn user prompts)
 *
 * The CRDT shape is what makes this safe: each row's `val` is the current
 * authoritative value, and there is no message stream to reverse-engineer.
 *
 * Output: a JSON array of `{ intent: "?", text }`. The `intent` is left blank
 * because `train-intent-weights.ts` only uses `text` and `probs` — the gold
 * label is record-keeping only, and the operator (or a downstream jev pass)
 * can fill it in for spot-checks. Empty / too-short / too-long / duplicate
 * (case-insensitive) texts are filtered out.
 *
 * Usage: npx --experimental-strip-types scripts/extract-intent-prompts-from-sessions.ts
 *        [ <sessions-dir> [ <out-file> ] ]
 *
 *   defaults:
 *     sessions-dir = C:\Users\<USER>\.dsh\storages\session_projcache\sessions
 *                   (or $DSH_SESSION_CACHE, or $USERPROFILE/.dsh/...)
 *     out-file     = scripts/intent-prompts-supplemental.json
 *
 * Read-only: this script never writes to `~/.dsh/...`. The only writes are
 * to `<out-file>` under the project.
 */
import { readdir, readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { homedir } from "node:os";

interface Prompt { intent: string; text: string; }

const INTENTS = ["fix", "verify", "research", "operate", "build"] as const;
const MIN_TEXT = 4;          // below this: not a real prompt (a stray "好" / "ok" carries no signal)
const MAX_TEXT = 240;        // above this: usually a long copy-paste, not a user-style intent
const MAX_PROMPTS_PER_FIELD_PER_FILE = 8; // cap so a single session can't dominate the supplement

function defaultSessionsDir(): string {
  if (process.env.DSH_SESSION_CACHE) return process.env.DSH_SESSION_CACHE;
  return join(homedir(), ".dsh", "storages", "session_projcache", "sessions");
}

function defaultOutPath(): string {
  return resolve(process.argv[3] ?? "scripts/intent-prompts-supplemental.json");
}

/** Walk the CRDT `record.rows` map; return all text-like fields. */
function extractTexts(recordRows: Record<string, unknown>): { source: string; text: string }[] {
  const out: { source: string; text: string }[] = [];

  const valOf = (key: string): unknown => {
    const row = recordRows[key];
    if (row === undefined || row === null || typeof row !== "object") return undefined;
    const v = (row as { val?: unknown }).val;
    return v;
  };

  // title: plain string
  const titleVal = valOf("title");
  if (typeof titleVal === "string" && titleVal.trim() !== "") {
    out.push({ source: "title", text: titleVal });
  }

  // titleInput: { first: { text }, count, lastSeq }
  const ti = valOf("titleInput");
  if (ti && typeof ti === "object") {
    const first = (ti as { first?: { text?: unknown } }).first;
    if (first && typeof first === "object" && typeof first.text === "string" && first.text.trim() !== "") {
      out.push({ source: "titleInput", text: first.text });
    }
  }

  // goal: { current: { goal: { objective, ... } } }
  const g = valOf("goal");
  if (g && typeof g === "object") {
    const current = (g as { current?: { goal?: { objective?: unknown } } }).current;
    const objective = current?.goal?.objective;
    if (typeof objective === "string" && objective.trim() !== "") {
      out.push({ source: "goal", text: objective });
    }
  }

  // turnOutline: { turns: [{ prompt, response, ... }, ...] } — collect only the prompts.
  const to = valOf("turnOutline");
  if (to && typeof to === "object") {
    const turns = (to as { turns?: unknown }).turns;
    if (Array.isArray(turns)) {
      let kept = 0;
      for (const t of turns) {
        if (kept >= MAX_PROMPTS_PER_FIELD_PER_FILE) break;
        if (t && typeof t === "object" && typeof (t as { prompt?: unknown }).prompt === "string") {
          const text = (t as { prompt: string }).prompt.trim();
          if (text !== "") { out.push({ source: "turnOutline", text }); kept++; }
        }
      }
    }
  }

  return out;
}

async function main(): Promise<void> {
  const sessionsDir = resolve(process.argv[2] ?? defaultSessionsDir());
  const outPath = defaultOutPath();

  let entries: string[];
  try {
    entries = (await readdir(sessionsDir)).filter((n) => n.endsWith(".json"));
  } catch (error) {
    console.error(`Cannot list ${sessionsDir}: ${(error as Error).message}`);
    process.exit(2);
  }
  console.error(`Reading ${entries.length} session files from ${sessionsDir}`);

  const seen = new Set<string>();
  const prompts: Prompt[] = [];
  let totalTexts = 0;
  let droppedShort = 0;
  let droppedLong = 0;
  let droppedDupe = 0;
  const perFileLimitExceeded = new Set<string>();

  for (const name of entries) {
    let obj: unknown;
    try { obj = JSON.parse(await readFile(join(sessionsDir, name), "utf8")); }
    catch { continue; } // skip unparseable files; the extractor must be tolerant

    const record = (obj && typeof obj === "object") ? (obj as { record?: { rows?: Record<string, unknown> } }).record : undefined;
    const rows = record?.rows;
    if (!rows || typeof rows !== "object") continue;

    const texts = extractTexts(rows);
    for (const t of texts) {
      totalTexts++;
      const trimmed = t.text.trim();
      if (trimmed.length < MIN_TEXT) { droppedShort++; continue; }
      if (trimmed.length > MAX_TEXT) { droppedLong++; continue; }
      const key = trimmed.toLowerCase();
      if (seen.has(key)) { droppedDupe++; continue; }
      seen.add(key);
      prompts.push({ intent: "?", text: trimmed });
    }
  }

  // Stable order: by text length asc, then by text asc. Easier to spot-check.
  prompts.sort((a, b) => a.text.length - b.text.length || a.text.localeCompare(b.text));

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(prompts, null, 2) + "\n", "utf8");

  // Report
  console.error(`Extracted ${prompts.length} unique prompts from ${totalTexts} raw texts across ${entries.length} files.`);
  console.error(`  dropped: ${droppedShort} short (< ${MIN_TEXT} chars), ${droppedLong} long (> ${MAX_TEXT}), ${droppedDupe} duplicate`);
  console.error(`  wrote:   ${outPath}`);
  // Show the first 5 + last 5 prompts as a sanity preview
  const head = prompts.slice(0, 5);
  const tail = prompts.slice(-5);
  console.error("  head:");
  for (const p of head) console.error(`    [${p.text.length.toString().padStart(3)}B] ${p.text}`);
  console.error("  tail:");
  for (const p of tail) console.error(`    [${p.text.length.toString().padStart(3)}B] ${p.text}`);

  // Intent label coverage: zero (all "?"), because the training script does not use it.
  // If a future round wants to label them, INTENTS lists the valid set.
  console.error(`  intent label: none (training script only reads text+probs; valid labels: ${INTENTS.join(", ")})`);
}

main().catch((e) => { console.error(e); process.exit(1); });
