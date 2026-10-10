/**
 * Distill Jev judgments into a per-signal probability table.
 *
 * Calls Jev once per prompt with 5 noul questions (one per TaskIntent),
 * saves the soft probability matrix as JSONL. Reads the API key from $JEV_KEY.
 *
 * Usage: JEV_KEY=... npx --experimental-strip-types scripts/distill-intent.ts
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const ENDPOINT = "https://pool.futureppo.top/v1/systemone";
const INTENTS = ["fix", "verify", "research", "operate", "build"] as const;
const CONCURRENCY = 6;

/**
 * Descriptive question wording beats the bare intent name.
 *
 * "Is this about build?" forces Jev to translate a Chinese request into an
 * English word before judging, and it under-scores `build` badly (0.17 for
 * "写个新方法" vs 0.95 with the description below). Ask about the *action
 * the user wants*, not the label we intend to assign.
 */
const QUESTIONS: Record<(typeof INTENTS)[number], string> = {
  fix: "Does the user want something broken repaired, or a defect corrected?",
  verify: "Does the user want work checked, tested, or confirmed?",
  research: "Does the user want information gathered, options compared, or a topic investigated?",
  operate: "Does the user want a running system deployed, maintained, configured, or monitored?",
  build: "Does the user want new functionality created, added, or written?",
};

interface Prompt { intent: string; text: string; }
interface Row { text: string; gold: string; probs: Record<string, number>; }

async function callJev(text: string, key: string, model = "jev-latest"): Promise<Record<string, number>> {
  const questions: Record<string, object> = {};
  for (const i of INTENTS) questions[i] = { type: "noul", instructions: QUESTIONS[i] };
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state: text, model, questions }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json() as { answers: Record<string, { noul: number }> };
  const out: Record<string, number> = {};
  for (const i of INTENTS) out[i] = data.answers[i]?.noul ?? 0;
  return out;
}

async function main() {
  const key = process.env.JEV_KEY;
  if (!key) { console.error("JEV_KEY env var required"); process.exit(2); }
  const promptsPath = resolve(process.argv[2] ?? "scripts/intent-prompts.json");
  const outPath = resolve(process.argv[3] ?? "scripts/intent-distilled.jsonl");
  const prompts: Prompt[] = JSON.parse(await readFile(promptsPath, "utf8"));
  console.error(`Loaded ${prompts.length} prompts; calling Jev with concurrency ${CONCURRENCY}...`);

  const results: Row[] = new Array(prompts.length);
  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < prompts.length) {
      const idx = cursor++;
      const p = prompts[idx];
      try {
        const probs = await callJev(p.text, key);
        results[idx] = { text: p.text, gold: p.intent, probs };
        process.stderr.write(`[${idx + 1}/${prompts.length}] ${p.text} -> ${JSON.stringify(probs)}\n`);
      } catch (e) {
        process.stderr.write(`[${idx + 1}/${prompts.length}] ERROR: ${(e as Error).message}\n`);
        results[idx] = { text: p.text, gold: p.intent, probs: Object.fromEntries(INTENTS.map(i => [i, 0.2])) };
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, results.map(r => JSON.stringify(r)).join("\n") + "\n", "utf8");
  console.error(`Wrote ${results.length} rows to ${outPath}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
