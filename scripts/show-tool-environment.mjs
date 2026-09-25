/**
 * Audit tool: print the environment a tool would receive, next to the
 * environment the operator is running in.
 *
 * Run it after changing anything about home resolution or tool isolation:
 *
 *     node --experimental-strip-types scripts/show-tool-environment.mjs [agentHome]
 *
 * What "good" looks like: every home, temp and config row differs between the
 * two columns. If `HOME` or `USERPROFILE` match, the agent is borrowing the
 * human's home directory and a stray `$home` can delete it.
 */

import { UnsafeAgentHomeError, buildToolEnvironment } from "../src/tool-environment.ts";

const agentHome = process.argv[2] ?? "./.personal-agent";
let environment;
try {
  environment = buildToolEnvironment({
    workspaceRoot: process.cwd(),
    agentHome,
  });
} catch (error) {
  if (error instanceof UnsafeAgentHomeError) {
    process.stderr.write(`refused: ${error.message}\n`);
    process.exit(2);
  }
  throw error;
}

const names = ["HOME", "USERPROFILE", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA", "XDG_CONFIG_HOME"];
const rows = names.map((name) => [name, String(process.env[name] ?? "—"), String(environment.env[name] ?? "—")]);
rows.push(["cwd", process.cwd(), environment.cwd]);

const width = (index) => Math.max(...rows.map((row) => row[index].length));
const w0 = width(0);
const w1 = width(1);

console.log(`${"variable".padEnd(w0)} | ${"operator (human)".padEnd(w1)} | tool (agent)`);
console.log("-".repeat(w0 + w1 + 22));
for (const [name, operator, tool] of rows) {
  const same = operator === tool;
  console.log(`${name.padEnd(w0)} | ${operator.padEnd(w1)} | ${tool}${same ? "   <-- SHARED" : ""}`);
}

// `cwd` is excluded on purpose: the working directory is *meant* to be the
// workspace root, which in this demo is the project directory itself. Sharing it
// is the design, not a leak.
const shared = rows.filter(([name, operator, tool]) => name !== "cwd" && operator === tool && operator !== "—");
console.log(
  shared.length === 0
    ? `\nOK: no home, temp or config location is shared with the operator.\n    cwd is the workspace root by design.`
    : `\nWARNING: ${shared.length} location(s) shared with the operator: ${shared.map(([n]) => n).join(", ")}`,
);
