/**
 * One-off tool-byte distribution measurement (D128 §九·六).
 *
 * This file is **test-only**. It does not touch product code, does not touch
 * DSH, and the only side effect is a small set of files in the test fixture
 * directory. The point is to produce an honest byte histogram of the tool
 * result contents a real personal-agent run would see, so the question
 * "what's a sensible `obsProjectionThreshold`?" has a measured answer
 * instead of a guess. Numbers printed in the test output; they are also
 * reproduced in D128 §九·六 of REFERENCE_DECISIONS.md.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Buffer } from "node:buffer";

import { createRunCommandTool, createReadFileTool, type Tool, type ToolContext } from "../src/tools.ts";
import { buildToolEnvironment } from "../src/tool-environment.ts";
import { createTestFixture } from "./fixtures.ts";

interface Measurement {
  readonly tool: string;
  readonly call: string;
  readonly bytes: number;
  readonly lines: number;
  readonly truncated: boolean;
}

const measurements: Measurement[] = [];

function wrap(tool: Tool, name: string): Tool {
  const original = tool.execute;
  const wrapped: Tool = {
    ...tool,
    async execute(args, context) {
      const result = await original.call(tool, args, context);
      const content = result.content ?? "";
      const bytes = Buffer.byteLength(content, "utf8");
      const lines = content === "" ? 0 : content.split("\n").length;
      // The marker text the shell tool appends when its 64 KiB cap binds is
      // the only "truncated" signal the codebase emits today, so check for
      // it directly rather than asking the tool to report.
      const truncated = /output truncated at \d+ bytes\]/i.test(content);
      const head = content.length > 120 ? content.slice(0, 120).replace(/\n/g, "\\n") + "…" : content.replace(/\n/g, "\\n");
      measurements.push({ tool: name, call: `${summarize(name, args)} | head=${JSON.stringify(head)}`, bytes, lines, truncated });
      return result;
    },
  };
  return wrapped;
}

function summarize(tool: string, args: Record<string, unknown>): string {
  if (tool === "run_command") return `cmd=${String((args as { command?: unknown }).command ?? "").slice(0, 60)}`;
  if (tool === "read_file" || tool === "inspect_file") return `path=${String((args as { path?: unknown }).path ?? "")}`;
  return JSON.stringify(args).slice(0, 80);
}

function percentile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(q * (sorted.length - 1))));
  return sorted[index]!;
}

function report(): void {
  if (measurements.length === 0) return;
  const sizes = measurements.map((m) => m.bytes).sort((a, b) => a - b);
  const sum = sizes.reduce((a, b) => a + b, 0);
  const mean = sum / sizes.length;
  const max = sizes[sizes.length - 1]!;
  const min = sizes[0]!;
  const truncated = measurements.filter((m) => m.truncated).length;

  const buckets: ReadonlyArray<readonly [number, number, string]> = [
    [0, 256, "0–256 B"],
    [256, 1024, "256 B–1 KiB"],
    [1024, 4 * 1024, "1–4 KiB"],
    [4 * 1024, 16 * 1024, "4–16 KiB"],
    [16 * 1024, 64 * 1024, "16–64 KiB"],
    [64 * 1024, Number.POSITIVE_INFINITY, "≥ 64 KiB"],
  ];
  const histogram = buckets.map(([lo, hi, label]) => ({
    label,
    count: sizes.filter((s) => s >= lo && s < hi).length,
  }));

  // Use a single `console.log` so the test runner keeps the block together.
  const lines: string[] = [];
  lines.push("");
  lines.push("=== D128 §九·六 tool-byte measurement ===");
  lines.push(`n = ${sizes.length} calls  (truncated-by-tool-cap: ${truncated})`);
  lines.push(`min = ${min}  mean = ${mean.toFixed(0)}  max = ${max}`);
  lines.push(`p50 = ${percentile(sizes, 0.5)}  p75 = ${percentile(sizes, 0.75)}  p90 = ${percentile(sizes, 0.9)}  p95 = ${percentile(sizes, 0.95)}  p99 = ${percentile(sizes, 0.99)}`);
  lines.push("Histogram:");
  for (const h of histogram) lines.push(`  ${h.label.padEnd(14)} ${h.count}`);
  lines.push("Per call (sorted by bytes):");
  for (const m of [...measurements].sort((a, b) => a.bytes - b.bytes)) {
    lines.push(`  ${m.tool.padEnd(15)} ${m.bytes.toString().padStart(7)} B  lines=${m.lines.toString().padStart(4)}  ${m.truncated ? "[TRUNCATED] " : ""}${m.call}`);
  }
  lines.push("=== End ===");
  lines.push("");
  console.log(lines.join("\n"));
}

describe("D128 §九·六 — real tool byte distribution", () => {
  it("exercises real tools on varied inputs and reports the histogram", async () => {
    const fixture = await createTestFixture("measure-tool-bytes");
    try {
      const workspaceRoot = fixture.workspaceRoot;
      // `run_command` requires a rebuilt environment (D55 / `requireToolEnvironment`)
      // AND an approve channel (D26). The previous revisions missed one or both
      // and the shell tool returned 46-byte fail messages — that was noise, not
      // data. Auto-approve all here because this is a measurement harness, not
      // a capability test.
      const toolEnvironment = buildToolEnvironment({ workspaceRoot, agentHome: fixture.home });
      const ctx: ToolContext = { workspaceRoot, toolEnvironment, approve: async () => true };

      // Varied-size files in the workspace. Sizes chosen to span the
      // interesting ranges: well under a recall page, around the page
      // boundary, and well above the shell cap.
      await writeFile(join(workspaceRoot, "small.json"), JSON.stringify({ ok: true, n: 7 }), "utf8");
      await writeFile(join(workspaceRoot, "medium.txt"), ("x".repeat(8_000) + "\n").repeat(2), "utf8"); // 16 KiB
      await writeFile(join(workspaceRoot, "large.txt"), ("line\n").repeat(8_000), "utf8"); // ~40 KiB
      await writeFile(join(workspaceRoot, "huge.txt"), "y".repeat(200_000), "utf8"); // 200 KiB
      await writeFile(join(workspaceRoot, "binary.bin"), Buffer.from([0, 1, 2, 3, 0xff, 0xfe, 0, 0, 0, 0]), "utf8");

      const shell = wrap(createRunCommandTool(), "run_command");
      const read = wrap(createReadFileTool(), "read_file");

      // run_command: cover empty, short, medium, large, and "blows past cap"
      await shell.execute({ command: "echo hi" }, ctx);
      await shell.execute({ command: "echo $null" }, ctx);
      await shell.execute({ command: "node -e \"process.stdout.write('a'.repeat(200000))\"" }, ctx);
      await shell.execute({ command: "node -e \"let s=''; for (let i=0;i<2000;i++) s += 'line '+i+String.fromCharCode(10); process.stdout.write(s)\"" }, ctx);
      // A more "model-like" shell: list a directory the model would see in
      // its working dir. On Windows `dir` emits a few hundred bytes; on
      // POSIX `ls -la` is similar. Either is small but realistic.
      await shell.execute({ command: "node -e \"process.stdout.write(require('fs').readdirSync('.').join(String.fromCharCode(10))\"" }, ctx);
      // A 50 KB structured "log line" stream — the kind of output a build
      // step or test runner actually produces.
      await shell.execute({ command: "node -e \"for(let i=0;i<500;i++) process.stdout.write('2026-01-01T00:00:00 INFO step '+i+' ok '+'x'.repeat(80)+String.fromCharCode(10))\"" }, ctx);

      // read_file: small, medium, large, huge (capped at READ_FILE_MAX_BYTES=256 KiB)
      await read.execute({ path: "small.json" }, ctx);
      await read.execute({ path: "medium.txt" }, ctx);
      await read.execute({ path: "large.txt" }, ctx);
      await read.execute({ path: "huge.txt" }, ctx);
      await read.execute({ path: "binary.bin" }, ctx);

      report();
      assert.ok(measurements.length >= 8, `expected ≥ 8 tool calls, got ${measurements.length}`);
    } finally {
      // ponytail: TestFixture intentionally has no `close` — per `fixtures.ts:15`,
      // the directory under `.test-artifacts/` is *retained for inspection*,
      // not cleaned up. The `?.()` was a silent no-op; drop the call.
    }
  });
});
