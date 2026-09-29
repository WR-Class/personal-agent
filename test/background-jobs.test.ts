/**
 * Background jobs (D47).
 *
 * The properties worth testing are the two that make background work safe rather
 * than the ones that make it work. Starting a job is easy; the failures that
 * matter are a job that cannot be stopped and output that grows without bound,
 * because neither is visible while it is happening. Each test here therefore
 * asserts something observable about a job that is genuinely running.
 *
 * The kill test is written against a child that reports it is alive by appending
 * to a file, rather than against a process handle: a handle can be gone while the
 * work continues, and an earlier measurement of exactly that shape is what
 * established that the agent's own child does die with it.
 */

import { after, describe, it } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  SPILL_RETENTION_MS,
  findJob,
  killJob,
  listJobs,
  prepareSpillDirectory,
  readJobOutput,
  shutdownJobs,
  startBackgroundJob,
} from "../src/background-jobs.ts";
import { shellFor } from "../src/shell-tool.ts";
import { buildToolEnvironment } from "../src/tool-environment.ts";

/**
 * A home and workspace inside a throwaway directory.
 *
 * Deliberately under the project directory rather than the system temp
 * directory: `buildToolEnvironment` refuses a home inside a protected host
 * location, and the system temp directory is one on Windows. That guard is
 * correct — it is what stops an agent home from landing in a location the
 * operator does not control — so these tests move rather than weaken it.
 */
const created: string[] = [];
function fixture(): { home: string; workspace: string; environment: ReturnType<typeof buildToolEnvironment> } {
  const base = mkdtempSync(path.join(process.cwd(), ".bg-fixture-"));
  created.push(base);
  const home = path.join(base, "home");
  const workspace = path.join(base, "ws");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { home, workspace, environment: buildToolEnvironment({ workspaceRoot: workspace, agentHome: home }) };
}

after(async () => {
  // Jobs must be stopped before the fixture directories go: a job that is still
  // running holds its log stream open, and deleting the directory underneath it
  // produces an unhandled ENOENT from the stream rather than a clean teardown.
  // This is the same shutdown path the agent uses, exercised here rather than
  // worked around.
  shutdownJobs();
  await wait(300);
  for (const directory of created) {
    rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
});

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Build a command that runs a script file, rather than quoting the script inline.
 *
 * Two quoting problems were measured here, and both were the test's rather than
 * the product's. A script passed as `node -e "..."` reaches node as `"for(let`
 * and dies with an unterminated string constant. A quoted absolute path fares no
 * better under `cmd.exe`, which prepends its own working directory and produces
 * `Cannot find module '...ws\"...ws\noisy.cjs"'` — the path twice over.
 *
 * So the script is written into the working directory and named without quotes or
 * a path: the job already runs with the workspace as its cwd, which is the same
 * arrangement the product gives a real command.
 */
function commandFor(directory: string, name: string, source: string): string {
  const file = path.join(directory, `${name}.cjs`);
  writeFileSync(file, source, "utf8");
  return `node ${name}.cjs`;
}

/** A command that appends to `marker` for as long as it is alive. */
function aliveCommand(directory: string, name: string, marker: string): string {
  return commandFor(
    directory,
    name,
    `const fs = require("fs");\n` +
      `setInterval(() => fs.appendFileSync(${JSON.stringify(marker)}, "tick\\n"), 150);\n`,
  );
}

describe("background jobs run and report", () => {
  it("returns an id immediately, then the output is readable", async () => {
    const { home, workspace } = fixture();
    const environment = buildToolEnvironment({ workspaceRoot: workspace, agentHome: home });
    const job = await startBackgroundJob("echo background-hello", environment, shellFor());
    // The id is what the model uses afterwards, so it has to exist before the
    // command finishes and has to be a string that can be passed back.
    assert.match(job.id, /^job-/);
    await wait(1500);
    const output = await readJobOutput(job.id);
    assert.match(output, /background-hello/, `expected the command output, got: ${output}`);
  });

  it("lists every job it started", async () => {
    const { home, workspace } = fixture();
    const environment = buildToolEnvironment({ workspaceRoot: workspace, agentHome: home });
    const before = listJobs().length;
    const job = await startBackgroundJob("echo listed", environment, shellFor());
    const after = listJobs();
    assert.equal(after.length, before + 1);
    assert.ok(after.some((entry) => entry.id === job.id));
  });

  it("reports a finished job's exit code", async () => {
    const { home, workspace } = fixture();
    const environment = buildToolEnvironment({ workspaceRoot: workspace, agentHome: home });
    const job = await startBackgroundJob("exit 3", environment, shellFor());
    await wait(1500);
    const record = findJob(job.id);
    assert.notEqual(record?.finishedAt, null, "the job never reported finishing");
    assert.equal(record?.exitCode, 3);
  });

  it("says so plainly when the job id is unknown", async () => {
    const output = await readJobOutput("job-does-not-exist");
    assert.match(output, /no such job/);
  });

  it("states how much output it is not showing", async () => {
    const { home, workspace } = fixture();
    const environment = buildToolEnvironment({ workspaceRoot: workspace, agentHome: home });
    // Emit well past the tail limit so truncation is certain.
    const job = await startBackgroundJob(
      commandFor(workspace, "noisy", "for (let i = 0; i < 20000; i++) console.log(\"line-\" + i);\n"),
      environment,
      shellFor(),
    );
    await wait(4000);
    const output = await readJobOutput(job.id);
    // The omission must be announced. Silent truncation would let a model reason
    // from a partial picture while believing it had all of it.
    assert.match(output, /earlier output omitted/, `expected an omission notice, got: ${output.slice(0, 200)}`);
  });
});

/**
 * Wait until `marker` stops growing, and fail if it never does.
 *
 * ⚠️ D85: this replaces a fixed 300 ms grace period, and the reason is a contract
 * distinction rather than a flake being papered over. `killJob` and `shutdownJobs`
 * launch `taskkill /PID … /T /F` and deliberately do not wait for it —
 * `background-jobs.ts:241-245` gives the reason: both run on the shutdown path and
 * inside a tool call, and blocking either on a process that is being killed would
 * turn a stopped job into a hung agent. So `true` from `killJob` means "the kill was
 * initiated", not "the process is dead", and `taskkill.exe` is itself a process that
 * has to be launched. Under the parallel load of a full suite run that can take longer
 * than 300 ms — which is what made these two tests fail intermittently for more than
 * twelve rounds while an isolated re-run of this file always passed.
 *
 * The property the module actually promises is that the job stops, and stops promptly
 * — `background-jobs.ts:15-18` calls a job that outlives the agent "the bad case,
 * because nothing tells the operator it is still there". So this polls until the file
 * stops growing and fails if that does not happen within the deadline. A job that
 * never dies keeps appending, the deadline expires, and the test says so with the
 * size it reached.
 *
 * ⚠️ What this deliberately no longer asserts: that not one further byte is written
 * after the kill call returns. That was never true, because the kill is asynchronous,
 * and asserting it was asserting an implementation detail as if it were the contract.
 * The relaxation is recorded here and in D85 rather than left implicit — a test that
 * gets more permissive without a written reason is how a real regression gets a
 * permanent home.
 */
async function awaitStoppedWriting(marker: string, deadlineMs: number): Promise<void> {
  const deadline = Date.now() + deadlineMs;
  let previous = readFileSync(marker, "utf8").length;
  while (Date.now() < deadline) {
    await wait(200);
    const current = readFileSync(marker, "utf8").length;
    if (current === previous) return;
    previous = current;
  }
  assert.fail(
    `the job was still writing ${deadlineMs} ms after the kill was initiated (marker reached ${previous} bytes); ` +
      `a few further ticks are expected because taskkill is launched without waiting, but growth that never stops is the failure this test exists to catch`,
  );
}

describe("a background job can be stopped", () => {
  it("kills the process, which is the property that makes it safe to leave running", async () => {
    const { home, workspace } = fixture();
    const environment = buildToolEnvironment({ workspaceRoot: workspace, agentHome: home });
    const marker = path.join(workspace, "alive.txt");
    writeFileSync(marker, "", "utf8");
    // Appends for as long as it lives, so the file's growth is evidence of life
    // that survives the process handle disappearing.
    const job = await startBackgroundJob(aliveCommand(workspace, "alive", marker), environment, shellFor());
    await wait(1200);
    const beforeKill = readFileSync(marker, "utf8").length;
    assert.ok(beforeKill > 0, "the job never started writing, so this test would prove nothing");

    assert.equal(killJob(job.id), true);
    // ⚠️ D85: no fixed grace period — see `awaitStoppedWriting` for why betting on
    // 300 ms was asserting an implementation detail rather than the contract. Ten
    // seconds is a deadline for a failure, not an expected duration; a healthy kill
    // settles in one or two 200 ms polls, so this is faster than the old shape on
    // the passing path and only slower when something is actually wrong.
    await awaitStoppedWriting(marker, 10_000);
  });

  it("reports an unknown job rather than pretending to stop something", () => {
    assert.equal(killJob("job-does-not-exist"), false);
  });
});

describe("closing the agent closes its jobs", () => {
  it("kills everything still running", async () => {
    const { home, workspace } = fixture();
    const environment = buildToolEnvironment({ workspaceRoot: workspace, agentHome: home });
    const marker = path.join(workspace, "shutdown.txt");
    writeFileSync(marker, "", "utf8");
    const job = await startBackgroundJob(aliveCommand(workspace, "shutdown", marker), environment, shellFor());
    await wait(1200);
    assert.ok(readFileSync(marker, "utf8").length > 0, "the job never started");

    const killed = shutdownJobs();
    assert.ok(killed >= 1, "shutdown reported nothing to stop");
    // ⚠️ D85: same shape as the `killJob` test, for the same reason — `shutdownJobs`
    // goes through the identical fire-and-forget `killTree`. The property the
    // operator asked for is "closing the agent closes the jobs", which is that they
    // stop, not that they stop within an arbitrary 300 ms of the call returning.
    await awaitStoppedWriting(marker, 10_000);
  });
});

describe("spilled output is bounded", () => {
  it("removes files past the retention age", async () => {
    const base = mkdtempSync(path.join(process.cwd(), ".spill-fixture-"));
    const stale = path.join(base, "job-stale.log");
    const fresh = path.join(base, "job-fresh.log");
    writeFileSync(stale, "old", "utf8");
    writeFileSync(fresh, "new", "utf8");
    // Backdate one file beyond the retention window.
    const old = new Date(Date.now() - SPILL_RETENTION_MS - 60_000);
    utimesSync(stale, old, old);

    await prepareSpillDirectory(base);
    assert.equal(existsSync(stale), false, "an expired spill file was kept");
    assert.equal(existsSync(fresh), true, "a current spill file was removed");
    rmSync(base, { recursive: true, force: true });
  });

  it("leaves files it did not create alone", async () => {
    // A blanket delete would remove whatever else lives in that directory. Only
    // the names this module writes may be pruned.
    const base = mkdtempSync(path.join(process.cwd(), ".spill-fixture-"));
    const foreign = path.join(base, "notes.txt");
    writeFileSync(foreign, "keep me", "utf8");
    const old = new Date(Date.now() - SPILL_RETENTION_MS - 60_000);
    utimesSync(foreign, old, old);

    await prepareSpillDirectory(base);
    assert.equal(existsSync(foreign), true, "an unrelated file in the spill directory was deleted");
    rmSync(base, { recursive: true, force: true });
  });

  it("is created under the agent home, not a shared temp directory", async () => {
    const { home, workspace } = fixture();
    const environment = buildToolEnvironment({ workspaceRoot: workspace, agentHome: home });
    const job = await startBackgroundJob("echo where", environment, shellFor());
    // Two sessions must not be able to read each other's output, and the agent
    // home is the boundary every other tool already respects.
    assert.ok(
      job.logPath.startsWith(home),
      `spill file ${job.logPath} is outside the agent home ${home}`,
    );
  });
});
