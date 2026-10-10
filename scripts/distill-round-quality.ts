/**
 * Distill Jev's round-quality judgment into a local scorer.
 *
 * Three stages in one file so the intermediate data is inspectable:
 *   1. label  — one Jev noul call per round: did the assistant actually
 *               accomplish the request?
 *   2. featurize — structural facts computable from the round alone, with no
 *               model call at all (lengths, echo detection, tool counts,
 *               code blocks, refusal phrases, ...)
 *   3. distill — mean Jev probability per feature, then a linear score that
 *               runs in-process with zero network.
 *
 * Usage:
 *   JEV_KEY=... node --dns-result-order=ipv4first --experimental-strip-types \
 *     scripts/distill-round-quality.ts label
 *   node --experimental-strip-types scripts/distill-round-quality.ts distill
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ENDPOINT = "https://pool.futureppo.top/v1/systemone";
const QUESTION =
  "Did the assistant's response actually accomplish what the user asked for? " +
  "Answer true only if the response substantively addresses the request. " +
  "Answer false if the response is empty, merely echoes the input, acknowledges " +
  "without doing the work, refuses, or is off-topic.";

interface Round {
  source: string;
  file: string;
  userPrompt: string;
  assistantOutput: string;
  steps: number;
  toolCalls: number;
  toolErrors: number;
  mechanical: "success" | "partial" | "empty";
}
interface Labeled extends Round { jev: number; }

const RAW = "D:/DSHXM/AgentKHD/personal-agent/scripts/rounds-raw.jsonl";
const LABELED = "D:/DSHXM/AgentKHD/personal-agent/scripts/rounds-labeled.jsonl";

async function callJev(state: string, key: string): Promise<number> {
  const res = await fetch(ENDPOINT, {
    method: "POST",
    headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      state, model: "jev-latest",
      questions: { accomplished: { type: "noul", instructions: QUESTION } },
    }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const data = await res.json() as { answers: Record<string, { noul: number }> };
  return data.answers.accomplished?.noul ?? 0;
}

// ---------------------------------------------------------------------------
// Features: every one is a fact about the round, not a guess about the topic.
// ---------------------------------------------------------------------------

export const FEATURES = [
  "outputEmpty",     // nothing came back
  "outputTiny",      // < 40 chars: "done", "ok"
  "outputShort",     // < 200 chars
  "outputLong",      // > 1500 chars
  "promptTerse",     // < 12 chars: "hi", "OK", "继续"
  "promptVerbose",   // > 500 chars: a real spec
  "isEcho",          // output repeats the prompt verbatim
  "ratioLow",        // output shorter than the prompt
  "noSteps",         // zero model turns
  "hasToolCalls",    // the round used tools at all
  "manyToolCalls",   // >= 5 tool calls
  "hasToolErrors",   // at least one tool failed
  "hasCodeFence",    // ``` in the output
  "hasHeading",      // markdown heading
  "hasList",         // markdown list
  // Refusal must be read as the *shape* of the answer, not a keyword that also
  // appears mid-sentence inside a long substantive reply ("不能简单归成…").
  "opensWithRefusal", // the reply leads with an apology / inability statement
  "asksQuestion",    // output ends by asking the user something
  "errorShaped",     // the output reads like a stack trace / error
  // The two failure modes D19 cannot see at all: a round that looked busy and
  // achieved nothing observable, and an imperative request that never reached
  // a tool.
  "busyNoTools",     // >= 3 model turns but zero tool calls
  "actionPromptNoTools", // prompt asks for an action, yet no tool was called
  "promiseOnly",     // leads with "I'll…" / 收到 / 我将 and shows no completion
] as const;
export type FeatureName = (typeof FEATURES)[number];

const REFUSAL_OPEN = /^\s*(抱歉|对不起|我没有|我需要(先)?(向您)?说明|无法|我不能|我这边没有|i (cannot|can't|am unable)|unable to|sorry)/i;
const ERROR_SHAPED = /(stack trace|traceback|\bat .+:\d+:\d+\)|Error:|Exception:|Errno|ENOENT|EPERM)/;
const ACTION_PROMPT = /(创建|新建|写[一了个]?|实现|做[一了个]?|读[取一]?|查看|查一下|列出|运行|执行|修改|修复|删除|部署|安装|create|write|implement|build|read|list|run|fix|delete|deploy|install)/i;
const PROMISE_OPEN = /^\s*(收到|好的|我将|我会|我这就|接下来|i'?ll|i will|let me|i'?m going to)/i;
/** Evidence that something actually finished, as opposed to being promised. */
const COMPLETION_EVIDENCE = /(已(经)?(完成|创建|写入|修改|删除|生成|建好)|完成[了。！]|done\.|finished|created|written|✅|通过|success)/i;

function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, " ").trim();
}

export function featurize(r: Round): Record<FeatureName, number> {
  const p = r.userPrompt ?? "";
  const o = r.assistantOutput ?? "";
  const ot = o.trim();
  const pn = normalize(p);
  const on = normalize(ot);
  const ratio = p.trim().length === 0 ? 1 : ot.length / p.trim().length;
  return {
    outputEmpty: ot.length === 0 ? 1 : 0,
    outputTiny: ot.length > 0 && ot.length < 40 ? 1 : 0,
    outputShort: ot.length < 200 ? 1 : 0,
    outputLong: ot.length > 1500 ? 1 : 0,
    promptTerse: p.trim().length < 12 ? 1 : 0,
    promptVerbose: p.trim().length > 500 ? 1 : 0,
    isEcho: on.length > 0 && on.length <= pn.length + 20 && pn.includes(on.replace(/^echo:\s*/, "")) ? 1 : 0,
    ratioLow: ratio < 1 ? 1 : 0,
    noSteps: r.steps === 0 ? 1 : 0,
    hasToolCalls: r.toolCalls > 0 ? 1 : 0,
    manyToolCalls: r.toolCalls >= 5 ? 1 : 0,
    hasToolErrors: r.toolErrors > 0 ? 1 : 0,
    hasCodeFence: /```/.test(o) ? 1 : 0,
    hasHeading: /^#{1,6}\s/m.test(o) ? 1 : 0,
    hasList: /^\s*([-*]|\d+\.)\s/m.test(o) ? 1 : 0,
    opensWithRefusal: REFUSAL_OPEN.test(ot) ? 1 : 0,
    asksQuestion: /[？?]\s*$/.test(ot) ? 1 : 0,
    errorShaped: ERROR_SHAPED.test(o) ? 1 : 0,
    busyNoTools: r.steps >= 3 && r.toolCalls === 0 ? 1 : 0,
    actionPromptNoTools: ACTION_PROMPT.test(p) && r.toolCalls === 0 ? 1 : 0,
    promiseOnly: PROMISE_OPEN.test(ot) && !COMPLETION_EVIDENCE.test(o) ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// label
// ---------------------------------------------------------------------------

async function label(): Promise<void> {
  const key = process.env.JEV_KEY;
  if (!key) { console.error("JEV_KEY required"); process.exit(2); }
  const rounds = (await readFile(RAW, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Round);
  console.log(`labeling ${rounds.length} rounds...`);
  const out: Labeled[] = [];
  for (let i = 0; i < rounds.length; i++) {
    const r = rounds[i]!;
    const state =
      `USER ASKED: ${r.userPrompt.slice(0, 600)}\n\n` +
      `ASSISTANT REPLIED: ${(r.assistantOutput ?? "").slice(0, 400) || "(empty)"}\n\n` +
      `FACTS: model turns=${r.steps}, tool calls=${r.toolCalls}, tool errors=${r.toolErrors}`;
    try {
      const jev = await callJev(state, key);
      out.push({ ...r, jev });
      process.stdout.write(`[${i + 1}/${rounds.length}] mech=${r.mechanical.padEnd(7)} jev=${jev.toFixed(2)} ${r.userPrompt.slice(0, 42).replace(/\n/g, " ")}\n`);
    } catch (e) {
      process.stderr.write(`[${i + 1}] ERROR ${(e as Error).message.slice(0, 60)}\n`);
    }
  }
  await writeFile(LABELED, out.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  console.log(`\nlabeled ${out.length}/${rounds.length} -> ${LABELED}`);
}

// ---------------------------------------------------------------------------
// distill
// ---------------------------------------------------------------------------

interface Weights {
  readonly features: readonly FeatureName[];
  /** Mean Jev probability when the feature is on, minus the base rate. */
  readonly weight: Record<string, number>;
  readonly base: number;
  readonly threshold: number;
  readonly trainedOn: number;
  readonly agreement: number;
}

function score(vec: Record<FeatureName, number>, w: Weights): number {
  let s = w.base;
  for (const f of w.features) s += (w.weight[f] ?? 0) * (vec[f] ?? 0);
  return Math.max(0, Math.min(1, s));
}

/**
 * Fit by a single pass of mean-difference weighting, then calibrate the
 * threshold on the same data. With ~54 rounds a full logistic fit would
 * memorise; this is honest about being a coarse signal reader, and `agreement`
 * below is reported from leave-one-out so it is not the training number.
 */
async function distill(): Promise<void> {
  const rows = (await readFile(LABELED, "utf8")).trim().split("\n").map((l) => JSON.parse(l) as Labeled);
  const base = rows.reduce((a, r) => a + r.jev, 0) / rows.length;
  const weight: Record<string, number> = {};
  for (const f of FEATURES) {
    const on = rows.filter((r) => featurize(r)[f] === 1);
    const off = rows.filter((r) => featurize(r)[f] === 0);
    if (on.length < 3 || off.length < 3) { weight[f] = 0; continue; }
    const meanOn = on.reduce((a, r) => a + r.jev, 0) / on.length;
    const meanOff = off.reduce((a, r) => a + r.jev, 0) / off.length;
    weight[f] = meanOn - meanOff;
  }
  const draft: Weights = { features: FEATURES, weight, base, threshold: 0.5, trainedOn: rows.length, agreement: 0 };

  // Choose the threshold that maximises leave-one-out agreement with Jev.
  const looPredict = (rowIdx: number, thr: number): { ok: boolean } => {
    const trial = rows.filter((_, i) => i !== rowIdx);
    const b = trial.reduce((a, r) => a + r.jev, 0) / trial.length;
    const w: Record<string, number> = {};
    for (const f of FEATURES) {
      const on = trial.filter((r) => featurize(r)[f] === 1);
      const off = trial.filter((r) => featurize(r)[f] === 0);
      if (on.length < 3 || off.length < 3) { w[f] = 0; continue; }
      w[f] = on.reduce((a, r) => a + r.jev, 0) / on.length - off.reduce((a, r) => a + r.jev, 0) / off.length;
    }
    const s = score(featurize(rows[rowIdx]!), { ...draft, base: b, weight: w });
    return { ok: (s >= thr ? 1 : 0) === (rows[rowIdx]!.jev >= 0.5 ? 1 : 0) };
  };

  let bestThr = 0.5;
  let bestAcc = -1;
  for (let thr = 0.05; thr <= 0.95; thr += 0.05) {
    const acc = rows.reduce((a, _, i) => a + (looPredict(i, thr).ok ? 1 : 0), 0) / rows.length;
    if (acc > bestAcc) { bestAcc = acc; bestThr = thr; }
  }
  const final: Weights = { ...draft, threshold: Number(bestThr.toFixed(2)), agreement: Number(bestAcc.toFixed(3)) };

  // Calibration artifacts live beside the scripts that make them, not in src/:
  // src/ is what the agent runs, and nothing at runtime reads this file. The
  // shipped behaviour is the four rules in cycle.ts:roundVeto — this JSON is the
  // experiment that produced them, and the evidence for rejecting it.
  const out = "D:/DSHXM/AgentKHD/personal-agent/scripts/round-quality-weights.json";
  await writeFile(out, JSON.stringify(final, null, 2) + "\n", "utf8");

  // Honest reporting.
  const agreement = rows.filter((r) => (score(featurize(r), final) >= final.threshold ? 1 : 0) === (r.jev >= 0.5 ? 1 : 0)).length;
  const mechAgreement = rows.filter((r) => (r.mechanical === "success" ? 1 : 0) === (r.jev >= 0.5 ? 1 : 0)).length;
  console.log(`trained on ${rows.length} rounds, base rate ${base.toFixed(3)}`);
  console.log(`\nfeature weights (mean Jev prob when ON minus when OFF):`);
  for (const f of [...FEATURES].sort((a, b) => Math.abs(weight[b]!) - Math.abs(weight[a]!))) {
    const bar = weight[f]! >= 0 ? "+" : "-";
    console.log(`  ${f.padEnd(16)} ${bar}${Math.abs(weight[f]!).toFixed(3)}`);
  }
  console.log(`\nthreshold ${final.threshold}`);
  console.log(`in-sample agreement with Jev : ${agreement}/${rows.length} = ${(100 * agreement / rows.length).toFixed(1)}%`);
  console.log(`leave-one-out agreement     : ${(100 * bestAcc).toFixed(1)}%  <- honest number`);
  console.log(`D19 mechanical agreement    : ${mechAgreement}/${rows.length} = ${(100 * mechAgreement / rows.length).toFixed(1)}%`);
  console.log(`\nwrote ${out}`);
}

// Only dispatch when run as the entry point, so eval-round-quality.ts can
// import `featurize` without triggering a label/distill pass.
const isEntry = process.argv[1]?.replace(/\\/g, "/").endsWith("distill-round-quality.ts") ?? false;
if (isEntry) {
  const mode = process.argv[2];
  if (mode === "label") await label();
  else if (mode === "distill") await distill();
  else { console.error("usage: distill-round-quality.ts <label|distill>"); process.exit(2); }
}
