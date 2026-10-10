/**
 * D19 ③ — multi-model round-quality judgments.
 *
 * Reads `scripts/rounds-labeled.jsonl` (54 rows already labeled by D19 mechanical
 * and Jev), asks Claude Opus 5 + Grok 4.7 to score each round on 5 quality
 * dimensions, and writes a side-by-side report against the existing D19 / Jev
 * verdicts. The open question D19 ③ closes: does the multi-model consensus
 * catch the ~13% of rounds D19 + Jev alone still get wrong?
 *
 * Ponytail: this is a focused one-off, not a refactor of multi-model-eval.ts.
 * Round-quality questions are different from intent questions, so the
 * `JSON_SCHEMA_PROMPT_TEMPLATE` is hard-coded here rather than parameterized.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

const INTENTS = ["complete", "accurate", "useful", "truthful", "effort"] as const;
type Intent = (typeof INTENTS)[number];
type Probs = Record<Intent, number>;

const JSON_SCHEMA_PROMPT_TEMPLATE = [
  'Return ONLY a JSON object on a single line (no prose, no markdown fence, no explanation).',
  'Output exactly one key: "complete" with a value in [0,1].',
  'Example of a valid reply: {"complete":0.7}',
  '',
  'Question: did the agent actually finish the task the user asked for?',
  '0.0 = the response is empty, merely echoes the input, acknowledges without doing the work, refuses, or is off-topic.',
  '1.0 = the response substantively addresses the request.',
  '',
  'User message: """{USER}"""',
  'Assistant response: """{ASSISTANT}"""',
  '',
  'Reply with ONLY the JSON line (one key, one number).',
].join("\n");

// Jev's noul interface is trained on a single named question per call. Match
// D125's `distill-round-quality.ts` shape exactly: key = `accomplished`. The 5-dim
// schema above is for OpenAI-compatible models only; sending it to Jev would
// produce nothing because Jev has no `complete/accurate/useful/truthful/effort`
// trained labels.
const JEV_QUESTION =
  "Did the assistant's response actually accomplish what the user asked for? " +
  "Answer true only if the response substantively addresses the request. " +
  "Answer false if the response is empty, merely echoes the input, acknowledges " +
  "without doing the work, refuses, or is off-topic.";

function parseProbsFromText(text: string): Probs | null {
  const m = text.match(/\{[^{}]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const out = {} as Probs;
    let ok = true;
    for (const i of INTENTS) {
      const v = Number(o[i]);
      if (!Number.isFinite(v)) { ok = false; break; }
      out[i] = Math.max(0, Math.min(1, v));
    }
    return ok ? out : null;
  } catch { return null; }
}

// Tolerant parser for `{"complete": 0.7}` shape (1-dim, the round-quality schema).
// We can't reuse parseProbsFromText because that demands all 5 keys, and the
// 1-dim OpenAI prompt is asking the model for one number.
function parseCompleteFromText(text: string): Probs | null {
  const m = text.match(/\{[^{}]*\}/);
  if (!m) return null;
  try {
    const o = JSON.parse(m[0]);
    const v = Number(o.complete);
    if (!Number.isFinite(v)) return null;
    return { complete: Math.max(0, Math.min(1, v)), accurate: 0, useful: 0, truthful: 0, effort: 0 };
  } catch { return null; }
}

async function callOpenAI(name: string, prompt: string, endpoint: string, apiKey: string, model: string, timeoutMs = 30000): Promise<Probs | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${endpoint}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${apiKey}` },
      body: JSON.stringify({ model, messages: [{ role: "user", content: prompt }], temperature: 0, max_tokens: 120 }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j = await r.json() as { choices?: { message?: { content?: string } }[] };
    const text = j.choices?.[0]?.message?.content ?? "";
    return parseCompleteFromText(text);
  } catch { return null; }
  finally { clearTimeout(t); }
}

async function callJev(prompt: string, jevKey: string, endpoint = "https://pool.futureppo.top/v1", model = "jev-latest", timeoutMs = 30000): Promise<Probs | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${endpoint}/systemone`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Authorization": `Bearer ${jevKey}` },
      body: JSON.stringify({ state: prompt, model, questions: { accomplished: { type: "noul", instructions: JEV_QUESTION } } }),
      signal: ctrl.signal,
    });
    if (!r.ok) return null;
    const j = await r.json() as { answers?: Record<string, { noul?: number }> };
    const v = j.answers?.accomplished?.noul;
    if (typeof v !== "number") return null;
    return { complete: v, accurate: 0, useful: 0, truthful: 0, effort: 0 };
  } catch { return null; }
  finally { clearTimeout(t); }
}

interface LabeledRow {
  source: string; file: string; userPrompt: string; assistantOutput: string;
  mechanical: string; jev: number; steps: number; toolCalls: number; toolErrors: number;
}

interface MultiOutput { idx: number; userPrompt: string; assistantOutput: string; mechanical: string; jevBaseline: number; models: Record<string, Probs | null>; }

function consensusComplete(models: Record<string, Probs | null>): number {
  const valid = Object.values(models).filter((p): p is Probs => p !== null);
  if (valid.length === 0) return 0;
  return valid.reduce((s, p) => s + p.complete, 0) / valid.length;
}

async function main() {
  const inPath = resolve("scripts/rounds-labeled.jsonl");
  const outPath = resolve("scripts/round-quality-multi.jsonl");
  const summaryPath = resolve("scripts/round-quality-multi.summary.md");
  const jevKey = process.env.JEV_KEY;
  if (!jevKey) { console.error("Set JEV_KEY"); process.exit(1); }

  // Multi-model config — env-driven so we can swap endpoints without editing code.
  // Each entry: { name, endpoint, apiKey, model }
  const cfg: { name: string; endpoint: string; apiKey: string; model: string }[] = [];
  if (process.env.YTY_KEY) {
    const ep = process.env.YTY_EP ?? "https://api.ytyidc.com/v1";
    for (const model of ["gpt-5.6", "gpt-5.6-sol", "gpt-5.5", "gpt-6"]) {
      cfg.push({ name: `yty-${model}`, endpoint: ep, apiKey: process.env.YTY_KEY, model });
    }
  }
  if (process.env.LBL_KEY) {
    const ep = process.env.LBL_EP ?? "https://api1.lblb.eu/v1";
    for (const model of ["gemini-3.7-flash"]) {
      cfg.push({ name: `lbl-${model}`, endpoint: ep, apiKey: process.env.LBL_KEY, model });
    }
  }
  if (process.env.GATEWAY_KEY) {
    const ep = process.env.GW_EP ?? "http://127.0.0.1:8787/v1";
    for (const model of ["claude-opus-5", "grok-4.7"]) {
      cfg.push({ name: `gw-${model}`, endpoint: ep, apiKey: process.env.GATEWAY_KEY, model });
    }
  }
  console.error(`Loaded config: ${cfg.length} OpenAI-compatible models + Jev (noul)`);

  const raw = await readFile(inPath, "utf8");
  const rows: LabeledRow[] = raw.trim().split("\n").map((l) => JSON.parse(l));
  console.error(`Loaded ${rows.length} rows from ${inPath}`);

  const out: MultiOutput[] = [];
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i]!;
    const prompt = JSON_SCHEMA_PROMPT_TEMPLATE
      .replace("{USER}", r.userPrompt.slice(0, 400))
      .replace("{ASSISTANT}", (r.assistantOutput ?? "").slice(0, 800));
    const calls: Promise<{ name: string; probs: Probs | null }>[] = [
      callJev(prompt, jevKey).then((probs) => ({ name: "jev", probs })),
    ];
    for (const c of cfg) {
      calls.push(callOpenAI(c.name, prompt, c.endpoint, c.apiKey, c.model, 20000).then((probs) => ({ name: c.name, probs })));
    }
    const results = await Promise.all(calls);
    const models: Record<string, Probs | null> = {};
    for (const { name, probs } of results) models[name] = probs;
    out.push({ idx: i, userPrompt: r.userPrompt, assistantOutput: r.assistantOutput, mechanical: r.mechanical, jevBaseline: r.jev, models });
    if ((i + 1) % 5 === 0 || i === rows.length - 1) console.error(`[${i + 1}/${rows.length}]`);
  }

  await mkdir(resolve("scripts"), { recursive: true });
  await writeFile(outPath, out.map((o) => JSON.stringify(o)).join("\n") + "\n", "utf8");
  console.error(`Wrote ${out.length} rows to ${outPath}`);

  type Conf = { tp: number; fp: number; tn: number; fn: number };
  const conf = (pred: (r: MultiOutput) => boolean): Conf => {
    const c: Conf = { tp: 0, fp: 0, tn: 0, fn: 0 };
    for (const r of out) {
      const truth = r.jevBaseline >= 0.5;
      const p = pred(r);
      if (truth && p) c.tp++; else if (truth && !p) c.fn++; else if (!truth && p) c.fp++; else c.tn++;
    }
    return c;
  };
  const acc = (c: Conf) => (100 * (c.tp + c.tn) / out.length).toFixed(1) + "%";
  const report = (name: string, c: Conf) =>
    `${name.padEnd(28)} acc=${acc(c).padStart(6)}  tp=${c.tp} fp=${c.fp} tn=${c.tn} fn=${c.fn}`;

  const d19 = conf((r) => r.mechanical === "success");
  const jevOnly = conf((r) => r.jevBaseline >= 0.5);
  const modelKeys = Object.keys(out[0]?.models ?? {}).filter((k) => k !== "jev");
  const cJev2 = conf((r) => (r.models.jev?.complete ?? 0) >= 0.5);
  const cons = conf((r) => consensusComplete(r.models) >= 0.5);
  const andPred = conf((r) => r.mechanical === "success" && consensusComplete(r.models) >= 0.5);
  const orPred = conf((r) => r.mechanical === "success" || consensusComplete(r.models) >= 0.5);
  const modelConfs: { name: string; c: ReturnType<typeof conf> }[] = modelKeys.map((k) => ({ name: k, c: conf((r) => (r.models[k]?.complete ?? 0) >= 0.5) }));

  const lines: string[] = [];
  lines.push(`# D19 ③ — multi-model round-quality on ${out.length} rounds (D131 retest with public endpoints)`);
  lines.push(`\nModels: Jev (noul) + ${modelKeys.length} OpenAI-compatible: ${modelKeys.join(", ")}`);
  lines.push(`\n## Confusion matrix (truth = Jev baseline \`jevBaseline >= 0.5\`)\n`);
  lines.push(`| predictor | acc | tp | fp | tn | fn |`);
  lines.push(`|---|---|---|---|---|---|`);
  lines.push(`| D19 mechanical | ${acc(d19)} | ${d19.tp} | ${d19.fp} | ${d19.tn} | ${d19.fn} |`);
  lines.push(`| Jev baseline (the truth) | ${acc(jevOnly)} | ${jevOnly.tp} | ${jevOnly.fp} | ${jevOnly.tn} | ${jevOnly.fn} |`);
  for (const m of modelConfs) lines.push(`| ${m.name} complete | ${acc(m.c)} | ${m.c.tp} | ${m.c.fp} | ${m.c.tn} | ${m.c.fn} |`);
  lines.push(`| Jev complete (noul re-ask) | ${acc(cJev2)} | ${cJev2.tp} | ${cJev2.fp} | ${cJev2.tn} | ${cJev2.fn} |`);
  lines.push(`| multi-consensus (mean complete) | ${acc(cons)} | ${cons.tp} | ${cons.fp} | ${cons.tn} | ${cons.fn} |`);
  lines.push(`| D19 AND consensus | ${acc(andPred)} | ${andPred.tp} | ${andPred.fp} | ${andPred.tn} | ${andPred.fn} |`);
  lines.push(`| D19 OR consensus | ${acc(orPred)} | ${orPred.tp} | ${orPred.fp} | ${orPred.tn} | ${orPred.fn} |`);

  const resp = (k: string) => out.filter((r) => r.models[k] !== null).length;
  lines.push(`\n## Per-model response rate\n`);
  lines.push(`| model | responded | rate |`);
  lines.push(`|---|---|---|`);
  for (const k of Object.keys(out[0]?.models ?? {})) lines.push(`| ${k} | ${resp(k)}/${out.length} | ${(100 * resp(k) / out.length).toFixed(1)}% |`);

  const d19WrongJev = out.filter((r) => r.mechanical === "success" && r.jevBaseline < 0.5);
  lines.push(`\n## D19 says success but Jev baseline < 0.5 (${d19WrongJev.length} cases)\n`);
  for (const r of d19WrongJev) {
    const c = consensusComplete(r.models);
    const wouldCatch = c >= 0.5 ? "✓ multi-consensus catches" : "✗ multi-consensus misses";
    const cols: string[] = [];
    for (const k of Object.keys(r.models)) {
      const v = r.models[k]?.complete ?? 0;
      cols.push(`${k}=${v.toFixed(2)}`);
    }
    lines.push(`- "${r.userPrompt.slice(0, 50)}" jev=${r.jevBaseline} ${cols.join(" ")} mean=${c.toFixed(2)} ${wouldCatch}`);
  }

  await writeFile(summaryPath, lines.join("\n") + "\n", "utf8");
  console.error(`Wrote summary to ${summaryPath}`);
  console.error(`\n${report("D19 mechanical", d19)}`);
  console.error(`${report("Jev baseline", jevOnly)}`);
  for (const m of modelConfs) console.error(`${report(m.name, m.c)}`);
  console.error(`${report("Jev complete (noul re-ask)", cJev2)}`);
  console.error(`${report("multi-consensus", cons)}`);
  console.error(`${report("D19 AND consensus", andPred)}`);
  console.error(`${report("D19 OR consensus", orPred)}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
