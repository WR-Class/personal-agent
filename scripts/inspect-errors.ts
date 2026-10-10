import { readFileSync } from "node:fs";
const rows = readFileSync("scripts/rounds-labeled.jsonl", "utf8").trim().split("\n").map((l) => JSON.parse(l));
const bad = rows.filter((r) => r.mechanical !== "empty" && r.jev < 0.5);
console.log(`=== mech=says-ok but Jev says failed (${bad.length}) ===`);
for (const r of bad) {
  console.log(`jev=${r.jev.toFixed(2)} mech=${r.mechanical} src=${r.source}`);
  console.log(`  prompt: ${JSON.stringify(r.userPrompt.slice(0, 60))}`);
  console.log(`  output: ${JSON.stringify((r.assistantOutput || "(empty)").slice(0, 120))}`);
  console.log(`  len=${r.assistantOutput?.length ?? 0} steps=${r.steps} tools=${r.toolCalls}/${r.toolErrors}`);
}
const good = rows.filter((r) => r.mechanical === "empty" && r.jev >= 0.5);
console.log(`\n=== mech=empty but Jev says ok (${good.length}) ===`);
for (const r of good) console.log(`jev=${r.jev.toFixed(2)} | ${JSON.stringify(r.userPrompt.slice(0, 60))}`);
