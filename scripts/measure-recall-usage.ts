/**
 * Has the oversized-result projection ever fired, and has `obs_recall` ever been
 * called? D128 §九·六(3) left that question open; this answers it from the
 * records the product already writes.
 *
 * Run it from `personal-agent/`:
 *
 *   node --experimental-strip-types scripts/measure-recall-usage.ts [home]
 *
 * `home` defaults to `.personal-agent`. **Read-only** — it opens session logs
 * and nothing else.
 *
 * Why a script rather than a number in a document: the answer changes as the
 * product is used, and a number nobody can re-derive is a number nobody should
 * trust. Re-run this instead of quoting the figure from the batch note.
 *
 * ⚠️ One trap this script exists to avoid. Counting event kinds directly finds
 * zero `tool/call` and zero `tool/result` events, which looks like "no tools
 * were ever used" — but this project records tool calls **inside message
 * events** (ADR-0001 D1: an assistant message's `toolCalls[]` is "what was
 * asked for", a `tool` message is "what came back"). Counting the wrong event
 * kind yields a confident zero that is simply wrong.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DEFAULT_OBS_PROJECTION_THRESHOLD_BYTES } from "../src/runtime.ts";

const home = resolve(process.argv[2] ?? ".personal-agent");

interface Message {
  role?: string;
  content?: unknown;
  toolCalls?: Array<{ name?: string }>;
}

const roles: Record<string, number> = {};
const toolNames: Record<string, number> = {};
let files = 0;
let messages = 0;
let assistantWithTools = 0;
let toolResults = 0;
let largest = 0;
let largestFile = "";
let largestPreview = "";
let recallCalls = 0;
let placeholderMarkers = 0;
const resultBytes: number[] = [];

for (const name of readdirSync(home)) {
  if (!name.endsWith(".jsonl")) continue;
  files++;
  const text = readFileSync(join(home, name), "utf8");
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    let record: { kind?: string; message?: Message };
    try {
      record = JSON.parse(line) as typeof record;
    } catch {
      continue; // A torn or non-JSON line is not this script's business.
    }
    if (record.kind !== "message" || record.message === undefined) continue;
    messages++;
    const role = String(record.message.role ?? "(none)");
    roles[role] = (roles[role] ?? 0) + 1;

    const calls = record.message.toolCalls;
    if (Array.isArray(calls) && calls.length > 0) {
      assistantWithTools++;
      for (const call of calls) {
        const tool = String(call?.name ?? "(unnamed)");
        toolNames[tool] = (toolNames[tool] ?? 0) + 1;
        if (tool === "obs_recall") recallCalls++;
      }
    }

    if (role === "tool") {
      toolResults++;
      const content = typeof record.message.content === "string" ? record.message.content : "";
      const bytes = Buffer.byteLength(content, "utf8");
      resultBytes.push(bytes);
      if (content.includes("tool result omitted from this projection")) placeholderMarkers++;
      if (bytes > largest) {
        largest = bytes;
        largestFile = name;
        largestPreview = content.slice(0, 120).replace(/\s+/g, " ");
      }
    }
  }
}

const kb = (n: number) => `${(n / 1024).toFixed(1)} KB`;

console.log(`agent home              = ${home}`);
console.log(`session logs read       = ${files}`);
console.log(`message events          = ${messages}`);
console.log(`  by role               = ${JSON.stringify(roles)}`);
console.log(`assistant msgs w/ tools = ${assistantWithTools}`);
console.log(`tool result messages    = ${toolResults}`);
console.log("");
console.log(`projection threshold    = ${kb(DEFAULT_OBS_PROJECTION_THRESHOLD_BYTES)}`);
console.log(`largest tool result     = ${kb(largest)}  (${largestFile})`);
if (largest > 0) {
  const pct = ((largest / DEFAULT_OBS_PROJECTION_THRESHOLD_BYTES) * 100).toFixed(0);
  console.log(`  reached               = ${pct}% of the threshold`);
  console.log(`  starts with           = ${JSON.stringify(largestPreview)}`);
}
console.log("");
console.log(`placeholder markers     = ${placeholderMarkers}`);
console.log(`obs_recall calls        = ${recallCalls}`);
console.log("");
// The distribution is the actionable half. D128 §九 ④ chose 32 KiB from a
// test-suite sample of eleven; a threshold is only as good as the distribution
// it was chosen against, so print that distribution rather than one number.
if (resultBytes.length > 0) {
  const sorted = [...resultBytes].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))]!;
  console.log(`tool result distribution over ${sorted.length} results:`);
  console.log(`  median                = ${kb(at(0.5))}`);
  console.log(`  p90                   = ${kb(at(0.9))}`);
  console.log(`  p99                   = ${kb(at(0.99))}`);
  console.log(`  max                   = ${kb(sorted[sorted.length - 1]!)}`);
  console.log("  would project at:");
  for (const candidate of [8, 16, 32, 64]) {
    const n = sorted.filter(bytes => bytes > candidate * 1024).length;
    const pct = ((n / sorted.length) * 100).toFixed(1);
    console.log(`    ${String(candidate).padStart(2)} KB             = ${n} of ${sorted.length} (${pct}%)`);
  }
}
console.log("");
console.log("tools used:");
for (const [tool, count] of Object.entries(toolNames).sort((a, b) => b[1] - a[1])) {
  console.log(`  ${tool.padEnd(22)} ${count}`);
}
