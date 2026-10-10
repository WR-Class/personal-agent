/**
 * Call Jev once per round to label "did the assistant actually accomplish the
 * user's request?". The user's prompt + the assistant's output are bundled
 * into the Jev `state` field; the question is one noul.
 *
 * Output: scripts/round-quality-labeled.jsonl with original round + jev_noul.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

interface Round {
  file: string;
  userPrompt: string;
  assistantOutput: string;
  mechanical: "success" | "empty";
}
interface Labeled extends Round {
  jev_noul: number;
}

const ENDPOINT = "https://pool.futureppo.top/v1/systemone";
const QUESTION = "Did the assistant's response actually accomplish what the user asked for? Answer true only if the response substantively addresses the user's request (not just acknowledges it, not empty, not off-topic, not an error message).";

async function callJev(state: string, key: string): Promise<number> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      state,
      model: "jev-latest",
      questions: { accomplished: { type: "noul", instructions: QUESTION } },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json() as { answers: Record<string, { noul: number }> };
  return data.answers.accomplished?.noul ?? 0;
}

async function main(): Promise<void> {
  const key = process.env.JEV_KEY;
  if (!key) { console.error("JEV_KEY env var required"); process.exit(2); }
  const home = "D:/DSHXM/AgentKHD/personal-agent/.personal-agent";
  const inPath = join(home, "round-transcripts.jsonl");
  const outPath = join(home, "round-quality-labeled.jsonl");
  const lines = (await readFile(inPath, "utf8")).trim().split("\n");
  const rounds: Round[] = lines.map((l) => JSON.parse(l) as Round);
  console.log(`labeling ${rounds.length} rounds via Jev noul...`);
  const out: Labeled[] = [];
  let i = 0;
  for (const r of rounds) {
    const out30 = (r.assistantOutput ?? "").slice(0, 300);
    const state = `USER ASKED: ${r.userPrompt.slice(0, 400)}\n\nASSISTANT REPLIED: ${out30}`;
    try {
      const jev = await callJev(state, key);
      out.push({ ...r, jev_noul: jev });
      console.log(`[${i + 1}/${rounds.length}] mech=${r.mechanical} jev=${jev.toFixed(2)} | ${r.userPrompt.slice(0, 50).replace(/\n/g, " ")}`);
    } catch (e) {
      console.error(`[${i + 1}] ERROR:`, (e as Error).message.slice(0, 80));
    }
    i++;
  }
  await writeFile(outPath, out.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  // Quick distribution
  const buckets = [0, 0, 0, 0, 0]; // [0-0.2, 0.2-0.4, 0.4-0.6, 0.6-0.8, 0.8-1.0]
  for (const r of out) buckets[Math.min(4, Math.floor(r.jev_noul * 5))]++;
  console.log("\nJEV distribution:");
  for (let b = 0; b < 5; b++) console.log(`  ${b * 0.2}-${(b + 1) * 0.2}: ${buckets[b]}`);
  const agree = out.filter((r) => (r.jev_noul > 0.5 ? "success" : "empty") === r.mechanical).length;
  console.log(`\nJev vs mechanical agreement: ${agree}/${out.length}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
