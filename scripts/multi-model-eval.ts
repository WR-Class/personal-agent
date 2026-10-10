/**
 * Multi-model intent-distillation harness (D131 候选).
 *
 * Runs the same 5 "noul" intent questions (D124 wording, see QUESTIONS below)
 * across N independent LLM providers in parallel, and writes the result as JSONL
 * plus an agreement summary.
 *
 * **Why not just use Jev** (D131 motivation): a single provider's labels are
 * just one opinion. D129 §六 showed Jev's labels drift on long prompts (the
 * "下创/立于/的新" OOV batch, the disagreeing verify/build split). D130 fixed
 * the training math but the LABELS are still one voice. A second/third voice
 * gives a sanity net: where two providers disagree the label is judgement,
 * not ground truth, and the user reviews the difference.
 *
 * **Provider adapters** (`type` field):
 *   - "jev": POST `{state, model, questions: {fix: {type:"noul",...}, ...}}`
 *            to `endpoint`, parse `data.answers[i].noul`. One call returns
 *            all 5 probabilities because Jev natively supports "noul" output.
 *   - "openai": POST to `<endpoint>/chat/completions` (or full URL override),
 *            ask the model to return ONLY a JSON object {fix..build: 0..1}.
 *            One call per prompt, all 5 numbers in one response.
 *
 * **Config** comes from ENV (NEVER from files — keys must not be persisted):
 *   JEV_KEY / OPENAI_API_KEY / CLAUDE_API_KEY — values to use
 *   EVAL_MODELS — JSON string of additional ModelConfig (or use defaults)
 *
 * **Usage**:
 *   JEV_KEY=... GATEWAY_KEY=... EVAL_PROMPT_FILE=... \
 *     npx --experimental-strip-types scripts/multi-model-eval.ts \
 *          [ <out.jsonl> [ <summary.md> ] ]
 *
 *   defaults:
 *     out        = scripts/intent-distilled-multi.jsonl
 *     summary    = scripts/intent-distilled-multi.summary.md
 *
 * **Output JSONL** (one row per prompt):
 *   { text, models: { jev: {fix..build}, openai_gpt4o: {..}, ... },
 *     consensus_argmax, agree_set, disagree_set }
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const INTENTS = ["fix", "verify", "research", "operate", "build"] as const;
type Intent = (typeof INTENTS)[number];
type Probs = Record<Intent, number>;

const QUESTIONS: Record<Intent, string> = {
  fix: "Does the user want something broken repaired, or a defect corrected?",
  verify: "Does the user want work checked, tested, or confirmed?",
  research: "Does the user want information gathered, options compared, or a topic investigated?",
  operate: "Does the user want a running system deployed, maintained, configured, or monitored?",
  build: "Does the user want new functionality created, added, or written?",
};

const CONCURRENCY_PER_MODEL = 4;

interface ModelConfig {
  name: string;
  type: "jev" | "openai";
  endpoint: string;
  apiKey: string;
  model: string;
}

interface Prompt { text: string; }
interface Row {
  text: string;
  models: Record<string, Probs>;
  consensus_argmax: Intent;
  agree_set: string[];
  disagree_set: string[];
}

function argmaxOf(p: Probs): Intent {
  let best: Intent = "fix";
  let bestVal = -Infinity;
  for (const i of INTENTS) if (p[i] > bestVal) { bestVal = p[i]; best = i; }
  return best;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

async function callJev(text: string, cfg: ModelConfig): Promise<Probs> {
  const questions: Record<string, object> = {};
  for (const i of INTENTS) questions[i] = { type: "noul", instructions: QUESTIONS[i] };
  const res = await fetch(cfg.endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({ state: text, model: cfg.model, questions }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json() as { answers: Record<string, { noul: number }> };
  const out = {} as Probs;
  for (const i of INTENTS) out[i] = clamp01(data.answers[i]?.noul ?? 0);
  return out;
}

const JSON_SCHEMA_PROMPT_TEMPLATE = [
  'Return ONLY a JSON object on a single line (no prose, no markdown fence, no explanation):',
  '{"fix": <0..1>, "verify": <0..1>, "research": <0..1>, "operate": <0..1>, "build": <0..1>}',
  '',
  'Each number is how confident you are the user request below matches that intent.',
  'The 5 numbers are INDEPENDENT marginals (do not need to sum to 1; pick the one with the highest number if you had to label).',
  '',
  'User request: """{TEXT}"""',
  '',
  'For each intent, the question is:',
  '- fix:      {qfix}',
  '- verify:   {qverify}',
  '- research: {qresearch}',
  '- operate:  {qoperate}',
  '- build:    {qbuild}',
  '',
  'Reply with ONLY the JSON line.',
].join("\n");

async function callOpenAI(text: string, cfg: ModelConfig): Promise<Probs> {
  const url = cfg.endpoint.endsWith("/chat/completions") ? cfg.endpoint : cfg.endpoint.replace(/\/+$/, "") + "/chat/completions";
  const prompt = JSON_SCHEMA_PROMPT_TEMPLATE
    .replace("{TEXT}", text)
    .replace("{qfix}", QUESTIONS.fix)
    .replace("{qverify}", QUESTIONS.verify)
    .replace("{qresearch}", QUESTIONS.research)
    .replace("{qoperate}", QUESTIONS.operate)
    .replace("{qbuild}", QUESTIONS.build);
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${cfg.apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: cfg.model,
      messages: [{ role: "user", content: prompt }],
      temperature: 0,
      max_tokens: 80,
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json() as { choices: { message: { content: string } }[] };
  const content = data.choices[0]?.message?.content ?? "";
  return parseProbsFromText(content);
}

/** Parse a JSON {"fix":..,"verify":..,...} line out of potentially noisy LLM text. */
export function parseProbsFromText(text: string): Probs {
  const empty: Probs = { fix: 0, verify: 0, research: 0, operate: 0, build: 0 };
  const m = text.match(/\{[^{}]*\}/);
  if (m) {
    try {
      const obj = JSON.parse(m[0]) as Record<string, unknown>;
      const out: Probs = { ...empty };
      let any = false;
      for (const i of INTENTS) {
        const v = obj[i];
        if (typeof v === "number") { out[i] = clamp01(v); any = true; }
      }
      if (any) return out;
    } catch { /* fall through to loose parse */ }
  }
  const loose = extractLoose(text);
  return { ...empty, ...loose };
}

function extractLoose(text: string): Partial<Probs> {
  const out: Partial<Probs> = {};
  for (const i of INTENTS) {
    const r = text.match(new RegExp(`"?${i}"?\\s*[:=]\\s*([0-9.]+)`));
    if (r) out[i] = clamp01(parseFloat(r[1] ?? "0"));
  }
  return out;
}

async function callOne(prompt: Prompt, cfg: ModelConfig): Promise<Probs> {
  if (cfg.type === "jev") return await callJev(prompt.text, cfg);
  return await callOpenAI(prompt.text, cfg);
}

function loadModels(): ModelConfig[] {
  const cfgs: ModelConfig[] = [];
  if (process.env.JEV_KEY) {
    cfgs.push({
      name: process.env.EVAL_JEV_NAME ?? "jev",
      type: "jev",
      endpoint: process.env.EVAL_JEV_ENDPOINT ?? "https://pool.futureppo.top/v1/systemone",
      apiKey: process.env.JEV_KEY,
      model: process.env.EVAL_JEV_MODEL ?? "jev-latest",
    });
  }
  if (process.env.EVAL_MODELS) {
    const parsed = JSON.parse(process.env.EVAL_MODELS);
    const entries: Array<[string, { type?: "jev" | "openai"; endpoint: string; apiKeyEnv?: string; apiKey?: string; model: string }]> =
      Array.isArray(parsed) ? parsed.map((c: ModelConfig | { name: string; type?: "jev" | "openai"; endpoint: string; apiKeyEnv?: string; apiKey?: string; model: string }, idx: number) => {
        const name = c.name ?? `m${idx}`;
        const cc: { type?: "jev" | "openai"; endpoint: string; apiKeyEnv?: string; apiKey?: string; model: string } = c as { type?: "jev" | "openai"; endpoint: string; apiKeyEnv?: string; apiKey?: string; model: string };
        return [name, cc] as [string, { type?: "jev" | "openai"; endpoint: string; apiKeyEnv?: string; apiKey?: string; model: string }];
      }) : Object.entries(parsed) as Array<[string, { type?: "jev" | "openai"; endpoint: string; apiKeyEnv?: string; apiKey?: string; model: string }]>;
    for (const [name, cc] of entries) {
      const apiKey = cc.apiKeyEnv ? process.env[cc.apiKeyEnv] : cc.apiKey;
      if (!apiKey) throw new Error(`model ${name}: missing API key (env ${cc.apiKeyEnv ?? "literal"})`);
      cfgs.push({ name, type: cc.type ?? "openai", endpoint: cc.endpoint, apiKey, model: cc.model });
    }
  }
  if (cfgs.length < 2) console.error(`Warning: only ${cfgs.length} model(s) configured — agreement matrix degenerates`);
  return cfgs;
}

async function main() {
  const promptPath = resolve(process.env.EVAL_PROMPT_FILE ?? "scripts/intent-prompts-supplemental.json");
  const outPath = resolve(process.argv[2] ?? "scripts/intent-distilled-multi.jsonl");
  const summaryPath = resolve(process.argv[3] ?? "scripts/intent-distilled-multi.summary.md");

  const models = loadModels();
  if (models.length === 0) { console.error("No models configured (set JEV_KEY and/or EVAL_MODELS)"); process.exit(2); }
  console.error(`Loaded ${models.length} model(s): ${models.map((m) => `${m.name}(${m.type}/${m.model})`).join(", ")}`);

  const prompts: Prompt[] = JSON.parse(await readFile(promptPath, "utf8"));
  console.error(`Loaded ${prompts.length} prompts from ${promptPath}; total calls = ${prompts.length * models.length} (concurrency ${CONCURRENCY_PER_MODEL}/model)`);

  const results: Row[] = new Array(prompts.length);
  const workQueue: Array<{ pIdx: number; m: ModelConfig }> = [];
  for (let i = 0; i < prompts.length; i++) for (const m of models) workQueue.push({ pIdx: i, m });

  let cursor = 0;
  async function worker(): Promise<void> {
    while (cursor < workQueue.length) {
      const idx = cursor++;
      const { pIdx, m } = workQueue[idx]!;
      const text = prompts[pIdx]!.text;
      try {
        const probs = await callOne(prompts[pIdx]!, m);
        const row = results[pIdx] ?? (results[pIdx] = {
          text,
          models: {},
          consensus_argmax: "fix",
          agree_set: [],
          disagree_set: [],
        });
        row.models[m.name] = probs;
        process.stderr.write(`[${idx + 1}/${workQueue.length}] ${m.name}: "${text.slice(0, 30)}${text.length > 30 ? "…" : ""}" -> ${JSON.stringify(probs)}\n`);
      } catch (e) {
        process.stderr.write(`[${idx + 1}/${workQueue.length}] ${m.name} ERROR on "${text.slice(0, 30)}…": ${(e as Error).message}\n`);
        const row = results[pIdx] ?? (results[pIdx] = {
          text,
          models: {},
          consensus_argmax: "fix",
          agree_set: [],
          disagree_set: [],
        });
        row.models[m.name] = { fix: 0.2, verify: 0.2, research: 0.2, operate: 0.2, build: 0.2 };
      }
    }
  }
  const totalConc = Math.min(CONCURRENCY_PER_MODEL * models.length, 16);
  await Promise.all(Array.from({ length: totalConc }, worker));

  for (const row of results) {
    const argmaxes = Object.entries(row.models).map(([name, p]) => ({ name, arg: argmaxOf(p) }));
    const counts: Partial<Record<Intent, string[]>> = {};
    for (const a of argmaxes) (counts[a.arg] ??= []).push(a.name);
    const consensus = Object.entries(counts).sort((a, b) => b[1].length - a[1].length)[0]!;
    row.consensus_argmax = consensus[0] as Intent;
    row.agree_set = consensus[1];
    row.disagree_set = argmaxes.filter((a) => a.arg !== row.consensus_argmax).map((a) => a.name);
  }

  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, results.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  console.error(`Wrote ${results.length} rows to ${outPath}`);

  const total = results.length;
  const allAgree = results.filter((r) => r.disagree_set.length === 0).length;
  const twoAgreeOneOff = results.filter((r) => r.disagree_set.length === 1).length;
  const perArgmax: Record<Intent, number> = { fix: 0, verify: 0, research: 0, operate: 0, build: 0 };
  for (const r of results) perArgmax[r.consensus_argmax]++;
  const modelArgmax: Record<string, Record<Intent, number>> = {};
  for (const m of models) {
    const dist = { fix: 0, verify: 0, research: 0, operate: 0, build: 0 };
    for (const r of results) {
      const arg = argmaxOf(r.models[m.name]!);
      dist[arg]++;
    }
    modelArgmax[m.name] = dist;
  }

  const summary = `# Multi-model intent distillation summary

Models: ${models.map((m) => `\`${m.name}\` (${m.type}/${m.model})`).join(", ")}
Prompts: ${total} (from \`${promptPath}\`)

## Agreement

| Bucket | Count | % |
|---|---|---|
| All models agree on argmax | ${allAgree} | ${(100 * allAgree / total).toFixed(1)}% |
| Exactly one model disagrees | ${twoAgreeOneOff} | ${(100 * twoAgreeOneOff / total).toFixed(1)}% |

## Consensus argmax distribution

| Intent | Count | % |
|---|---|---|
${INTENTS.map((i) => `| ${i} | ${perArgmax[i]} | ${(100 * perArgmax[i] / total).toFixed(1)}% |`).join("\n")}

## Per-model argmax distribution

| Model | fix | verify | research | operate | build |
|---|---|---|---|---|---|
${models.map((m) => `| ${m.name} | ${INTENTS.map((i) => modelArgmax[m.name]?.[i] ?? 0).join(" | ")} |`).join("\n")}

## Largest disagreement (top 20 by spread)

| prompt | consensus | disagree | per-model argmax |
|---|---|---|---|
${results
  .map((r) => ({
    r,
    spread: Object.values(r.models).reduce(
      (s, p) => s + Math.max(...INTENTS.map((x) => p[x])) - Math.min(...INTENTS.map((x) => p[x])),
      0,
    ),
  }))
  .sort((a, b) => b.spread - a.spread)
  .slice(0, 20)
  .map((x) => {
    const r = x.r;
    const cells = models.map((m) => `\`${m.name}:${argmaxOf(r.models[m.name]!)}\``).join(" ");
    return `| "${r.text.slice(0, 50).replace(/\|/g, "\\|").replace(/"/g, "'")}${r.text.length > 50 ? "…" : ""}" | ${r.consensus_argmax} | ${r.disagree_set.join(", ")} | ${cells} |`;
  })
  .join("\n")}
`;
  await writeFile(summaryPath, summary, "utf8");
  console.error(`Wrote summary to ${summaryPath}`);
}

// Same trap we hit on train-intent-weights.ts (D130): importing this file from
// a test triggers the top-level `main()`. Run only when this is the CLI entry.
if (import.meta.url === pathToFileURL(resolve(process.argv[1] ?? "")).href) {
  main().catch((e) => { console.error(e); process.exit(1); });
}
