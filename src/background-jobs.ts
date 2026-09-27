/**
 * Background jobs (D47).
 *
 * A command that takes minutes — installing a dependency, running a full test
 * suite — cannot be run in the foreground, because the foreground budget is what
 * keeps one turn from hanging forever. The measured consequence of not having
 * this: asking the agent to write and verify a small script in an earlier round
 * hit the five-minute run deadline and the turn died mid-task. The work was
 * nearly done; the budget, not the capability, was the limit.
 *
 * So a long command moves to the background and the operator keeps working. That
 * is the whole point, and it is also where the risk is, so what this module is
 * careful about is the two things that go wrong with background work:
 *
 * 1. **It must be stoppable.** A background process that outlives the agent is
 *    the bad case, because nothing tells the operator it is still there. Every
 *    job is registered here, and {@link shutdownJobs} kills all of them. The
 *    operator's decision was explicit: closing the agent closes the jobs.
 *    Measured before relying on it: the agent's own child can be killed, and a
 *    grandchild the command itself spawns dies with it, because the agent is the
 *    direct parent and Windows terminates the tree from there. (The orphans that
 *    were observed while designing this came from spawning through an
 *    intermediate shell, which is the operator's situation, not this one.)
 * 2. **Its output must be bounded.** A build log grows without limit, so output
 *    is spilled to a file under the agent's own home rather than accumulating in
 *    the process, and the spill directory is capped by age and by size. This
 *    follows crush's shape: a 7-day retention and a 256 MB directory ceiling,
 *    pruned oldest-first. Nothing here trusts the command to be quiet.
 */

import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, stat, unlink } from "node:fs/promises";
import path from "node:path";

import type { ToolEnvironment } from "./tool-environment.ts";

/** How long a foreground command may run before it is moved to the background. */
export const FOREGROUND_GRACE_MS = 60_000;
/** Spilled output older than this is removed. */
export const SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Hard ceiling on the whole spill directory. */
export const SPILL_DIR_LIMIT_BYTES = 256 * 1024 * 1024;
/** How much of a job's tail is returned when its output is read. */
export const JOB_OUTPUT_TAIL_BYTES = 32 * 1024;

export interface JobRecord {
  readonly id: string;
  readonly command: string;
  readonly pid: number | undefined;
  readonly startedAt: number;
  readonly logPath: string;
  exitCode: number | null;
  finishedAt: number | null;
}

interface RunningJob extends JobRecord {
  readonly child: ReturnType<typeof spawn>;
  /** Bytes written so far, so a read can report how much it is not showing. */
  bytesWritten: number;
}

const jobs = new Map<string, RunningJob>();
let counter = 0;

function spillDirectory(environment: ToolEnvironment): string {
  // Under the agent's own home, never a shared temp directory: two sessions must
  // not be able to read each other's job output, and the home is already the
  // boundary the tool environment establishes for everything else.
  return path.join(environment.env.HOME ?? environment.cwd, "shell-output");
}

/**
 * Create the spill directory and drop what is stale or over the ceiling.
 *
 * Pruning runs before a new job writes, so the directory is bounded even if the
 * pruning itself never gets a chance to finish. Age is checked first and size
 * second: an old file goes regardless of total size, and only then is the total
 * brought under the limit, oldest first.
 */
export async function prepareSpillDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  let names: string[];
  try {
    names = await readdir(directory);
  } catch {
    return;
  }
  const files: { name: string; size: number; mtimeMs: number }[] = [];
  for (const name of names) {
    // Only files this module creates. A blanket delete would remove whatever
    // else the operator happens to keep in that directory.
    if (!/^job-.*\.log$/.test(name)) continue;
    try {
      const info = await stat(path.join(directory, name));
      if (info.isFile()) files.push({ name, size: info.size, mtimeMs: info.mtimeMs });
    } catch {
      // Gone between listing and stat: nothing to prune.
    }
  }
  const cutoff = Date.now() - SPILL_RETENTION_MS;
  let kept = files.filter((file) => file.mtimeMs >= cutoff);
  for (const file of files) {
    if (!kept.includes(file)) await unlink(path.join(directory, file.name)).catch(() => {});
  }
  let total = kept.reduce((sum, file) => sum + file.size, 0);
  kept = kept.sort((a, b) => a.mtimeMs - b.mtimeMs);
  for (const file of kept) {
    if (total <= SPILL_DIR_LIMIT_BYTES) break;
    await unlink(path.join(directory, file.name)).catch(() => {});
    total -= file.size;
  }
}

/**
 * Start a command as a background job and return as soon as it has started.
 *
 * The child is deliberately **not** detached. A detached child escapes the
 * agent's own process tree, which would make cleanup depend on being able to find
 * it again rather than on the parent relationship; keeping it attached is what
 * makes killing the job reliable.
 */
export async function startBackgroundJob(
  command: string,
  environment: ToolEnvironment,
  shell: { executable: string; args: (command: string) => string[] },
): Promise<JobRecord> {
  const directory = spillDirectory(environment);
  await prepareSpillDirectory(directory);
  counter += 1;
  const id = `job-${Date.now().toString(36)}-${counter}`;
  const logPath = path.join(directory, `${id}.log`);

  const child = spawn(shell.executable, shell.args(command), {
    cwd: environment.cwd,
    env: environment.env as NodeJS.ProcessEnv,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  const job: RunningJob = {
    id,
    command,
    pid: child.pid,
    startedAt: Date.now(),
    logPath,
    exitCode: null,
    finishedAt: null,
    child,
    bytesWritten: 0,
  };
  jobs.set(id, job);

  const stream = createWriteStream(logPath);
  const write = (chunk: Buffer) => {
    job.bytesWritten += chunk.length;
    stream.write(chunk);
  };
  child.stdout?.on("data", write);
  child.stderr?.on("data", write);

  const settle = (code: number | null) => {
    if (job.finishedAt !== null) return;
    job.exitCode = code;
    job.finishedAt = Date.now();
    stream.end();
  };
  child.on("error", (error) => {
    write(Buffer.from(`\ncould not run the shell: ${error.message}\n`, "utf8"));
    settle(null);
  });
  child.on("close", (code) => settle(code));

  return job;
}

export function findJob(id: string): JobRecord | undefined {
  return jobs.get(id);
}

export function listJobs(): readonly JobRecord[] {
  return [...jobs.values()];
}

export function isRunning(job: JobRecord): boolean {
  return job.finishedAt === null;
}

/**
 * Read a job's output.
 *
 * Only the tail is returned, and the amount omitted is stated rather than the
 * output being silently cut. A model given the last few kilobytes with no
 * indication that earlier output exists will reason from a partial picture, which
 * is worse than being told the picture is partial.
 */
export async function readJobOutput(id: string): Promise<string> {
  const job = jobs.get(id);
  if (!job) return `no such job: ${id}`;
  let text = "";
  try {
    text = await readFile(job.logPath, "utf8");
  } catch {
    text = "";
  }
  const status = job.finishedAt === null ? "running" : `finished with exit code ${job.exitCode}`;
  const header = `${job.id} (${status}): ${job.command}`;
  if (text.length === 0) return `${header}\n(no output yet)`;
  if (Buffer.byteLength(text, "utf8") <= JOB_OUTPUT_TAIL_BYTES) return `${header}\n${text}`;
  const tail = Buffer.from(text, "utf8").subarray(-JOB_OUTPUT_TAIL_BYTES).toString("utf8");
  const omitted = Buffer.byteLength(text, "utf8") - JOB_OUTPUT_TAIL_BYTES;
  return `${header}\n[earlier output omitted: ${omitted} bytes]\n${tail}`;
}

/**
 * Stop one job.
 *
 * Killing the direct child is not enough on Windows, and this was measured
 * rather than assumed: the job's process is `cmd.exe`, which spawns the actual
 * command as *its* child, so `child.kill()` terminates the interpreter and leaves
 * the command running. The evidence was a job that kept appending to a file at
 * the same rate after `kill()` reported success — the failure mode that matters,
 * because the tool said the job had stopped.
 *
 * So the whole tree is killed with `taskkill /T /F` on Windows, which targets the
 * process and its descendants by pid. Elsewhere the direct child really is the
 * command, so `kill()` is correct and `taskkill` does not exist.
 */
export function killJob(id: string): boolean {
  const job = jobs.get(id);
  if (!job) return false;
  if (job.finishedAt !== null) return true;
  killTree(job);
  return true;
}

/**
 * Kill a job's process and everything it started.
 *
 * `taskkill` is used with `stdio: "ignore"` and without waiting: this runs on the
 * shutdown path and inside a tool call, and blocking either on a process that is
 * being killed would turn a stopped job into a hung agent. A failure to launch
 * `taskkill` falls back to the direct kill, which is at least the right shape
 * even when it is not sufficient.
 */
function killTree(job: RunningJob): void {
  if (job.pid === undefined) {
    try {
      job.child.kill();
    } catch {
      // Nothing to kill.
    }
    return;
  }
  if (process.platform === "win32") {
    try {
      const killer = spawn("taskkill", ["/PID", String(job.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.on("error", () => {
        // `taskkill` unavailable: fall back rather than leaving the job running.
        try {
          job.child.kill();
        } catch {
          // Already gone.
        }
      });
      return;
    } catch {
      // Fall through to the direct kill below.
    }
  }
  try {
    job.child.kill();
  } catch {
    // Already exited between the check and the kill.
  }
}

/**
 * Kill every job. Called when the agent shuts down.
 *
 * The operator chose this explicitly over letting jobs outlive the agent, and the
 * reason is worth keeping: a job that survives the agent's exit is invisible —
 * nothing left running would report that it is still writing to disk. Killing on
 * exit makes "the agent is closed" mean "nothing of mine is still running",
 * which is a statement an operator can actually rely on.
 */
export function shutdownJobs(): number {
  let killed = 0;
  for (const job of jobs.values()) {
    if (job.finishedAt !== null) continue;
    killTree(job);
    killed += 1;
  }
  return killed;
}
