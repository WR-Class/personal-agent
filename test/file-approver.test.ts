import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, existsSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const cli = await import("../src/cli.ts") as { createFileApprover?: (dir: string, opts: { signal: AbortSignal | undefined; requestLog: (line: string) => void; timeoutMs?: number; pollMs?: number }) => (prompt: string) => Promise<boolean> };
if (typeof cli.createFileApprover !== "function") throw new Error("createFileApprover not exported from cli.ts");

function dir(): string { return mkdtempSync(join(tmpdir(), "pa-approve-")); }
function cleanup(h: string): void { rmSync(h, { recursive: true, force: true }); }

test('file approver returns false on timeout', async () => {
  const home = dir();
  try {
    const approver = cli.createFileApprover!(home, { signal: undefined, requestLog: () => { /* quiet */ }, timeoutMs: 200, pollMs: 50 });
    const result = await approver("test timeout");
    assert.equal(result, false);
    assert.ok(readdirSync(home).some((f) => f.endsWith(".request")));
  } finally { cleanup(home); }
});

test('file approver returns true when a yes decision is written', async () => {
  const home = dir();
  try {
    const approver = cli.createFileApprover!(home, { signal: undefined, requestLog: () => { /* quiet */ } });
    const p = approver("test yes");
    await new Promise((r) => setTimeout(r, 50));
    const request = readdirSync(home).find((f) => f.endsWith(".request"));
    const hash = request!.replace(".request", "");
    writeFileSync(join(home, `${hash}.decision`), "yes\n", "utf8");
    assert.equal(await p, true);
    assert.ok(existsSync(join(home, `${hash}.resolved`)));
  } finally { cleanup(home); }
});

test('file approver returns false when a no decision is written', async () => {
  const home = dir();
  try {
    const approver = cli.createFileApprover!(home, { signal: undefined, requestLog: () => { /* quiet */ } });
    const p = approver("test no");
    await new Promise((r) => setTimeout(r, 50));
    const request = readdirSync(home).find((f) => f.endsWith(".request"));
    const hash = request!.replace(".request", "");
    writeFileSync(join(home, `${hash}.decision`), "no\n", "utf8");
    assert.equal(await p, false);
    assert.equal(readFileSync(join(home, `${hash}.resolved`), "utf8").trim(), "no");
  } finally { cleanup(home); }
});