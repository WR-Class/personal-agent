/**
 * Probe the live CLI and print each assistant turn with the time since the previous one.
 *
 * ⚠️ Kept in the repository on purpose (D162). It began as a one-off, written while a
 * live case passed once at 318s and then failed twice at ~360s with the provider's own
 * 502, while the control arm finished in 15s — a 20x difference is not something to call
 * flakiness before looking at the turns. What it produced was not merely an explanation:
 * the per-turn transcript **falsified** a claim recorded in D159 about how a round ends.
 * An instrument that overturned a recorded finding is not litter, and deleting it would
 * make that finding unreproducible.
 *
 * It is slow, it spends real tokens, and it talks to whatever provider `--home` is
 * configured for, so it is **not a test** and the suite must never run it.
 *
 *   node --experimental-strip-types scripts/d159-live-probe.ts <command|files|none> [sessionId]
 */
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";

import { main } from "../src/cli.ts";
import { SessionStore } from "../src/session-store.ts";

const seed = process.argv[2] ?? "command";
const sessionId = process.argv[3] ?? `probe-${seed}`;

// Inside the project's own artifacts directory: the OS temp directory is refused
// by `assertSafeStateDirectory`, which is the right answer and not something to
// work around.
const root = await mkdtemp(join(process.cwd(), ".test-artifacts", "d159-"));
const home = join(root, "home");
const workspaceRoot = join(root, "ws");
await mkdir(home, { recursive: true });
await mkdir(workspaceRoot, { recursive: true });
await writeFile(join(workspaceRoot, "notes.txt"), "plain workspace text\n", "utf8");

const store = new SessionStore({ root: home });
await store.create(sessionId);
if (seed === "command") {
  await store.appendTaskState(sessionId, {
    state: "把工作区里的 notes.txt 读出来",
    steps: [{ text: "确认 Node 版本", claim: { kind: "command", command: "node --version" } }],
  });
} else if (seed === "files") {
  await store.appendTaskState(sessionId, {
    state: "把工作区里的 notes.txt 读出来",
    steps: [{ text: "写 notes.txt", claim: { kind: "files-written", paths: ["notes.txt"] } }],
  });
}

const written: string[] = [];
const io = {
  interactive: false,
  async ask() { return null; },
  write(text: string) { written.push(text); },
  onInterrupt() { return () => {}; },
  close() {},
};

const started = Date.now();
let code = -1;
let failure = "";
try {
  code = await main(
    ["--home", home, "--workspace", workspaceRoot, "--max-steps", "8", "--tier", "ask-before-writing",
      "--session", sessionId, "读一下工作区里的 notes.txt,把它第一行的内容原样告诉我。"],
    process.env,
    io,
  );
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
}

const text = await readFile(join(home, `${sessionId}.jsonl`), "utf8").catch(() => "");
let previous = started;
let index = 0;
const lines: string[] = [];
for (const line of text.split("\n").filter(Boolean)) {
  let event: { at?: unknown; message?: { role?: string; toolCalls?: { name?: string; arguments?: unknown }[] } };
  try { event = JSON.parse(line); } catch { continue; }
  if (event.message?.role !== "assistant") continue;
  index += 1;
  const at = typeof event.at === "number" ? event.at : Date.parse(String(event.at));
  const calls = event.message.toolCalls ?? [];
  lines.push(
    `turn ${index}  +${((at - previous) / 1000).toFixed(1)}s  tools=[${calls.map((c) => c.name).join(",")}]  ` +
    calls.map((c) => String(c.arguments).slice(0, 100)).join(" | "),
  );
  previous = Number.isFinite(at) ? at : previous;
}

console.log(`seed=${seed} exit=${code} elapsed=${((Date.now() - started) / 1000).toFixed(1)}s`);
if (failure !== "") console.log(`failure: ${failure}`);
console.log(lines.join("\n") || "(no assistant turns recorded)");
console.log("---- output tail ----");
console.log(written.join("").slice(-700));
console.log(`fixture=${root}`);
