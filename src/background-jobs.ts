import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, open, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import type { ToolEnvironment } from './tool-environment.ts';
import { boundedCleanup, processGroupOptions, terminateProcessTree } from './process-tree.ts';

export const FOREGROUND_GRACE_MS = 60_000;
export const SPILL_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const SPILL_DIR_LIMIT_BYTES = 256 * 1024 * 1024;
export const JOB_OUTPUT_TAIL_BYTES = 32 * 1024;
export const JOB_SPILL_LIMIT_BYTES = 4 * 1024 * 1024;
export interface JobRecord {
  readonly id: string;
  readonly owner?: string;
  readonly command: string;
  readonly pid: number | undefined;
  readonly startedAt: number;
  readonly logPath: string;
  exitCode: number | null;
  finishedAt: number | null;
}
interface RunningJob extends JobRecord {
  child: ReturnType<typeof spawn>;
  done: Promise<void>;
  stopping?: Promise<void>;
  stopError?: Error;
  bytesWritten: number;
  truncated: boolean;
}
const jobs = new Map<string, RunningJob>();
let counter = 0;

export async function prepareSpillDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true });
  const files: { name: string; size: number; mtimeMs: number }[] = [];
  for (const name of await readdir(directory)) {
    if (!/^job-.*\.log$/.test(name) || [...jobs.values()].some(j => j.logPath === path.join(directory, name) && isRunning(j))) continue;
    try { const info = await stat(path.join(directory, name)); if (info.isFile()) files.push({ name, size: info.size, mtimeMs: info.mtimeMs }); } catch { /* disappeared */ }
  }
  let total = files.reduce((sum, file) => sum + file.size, 0);
  for (const file of files.sort((a, b) => a.mtimeMs - b.mtimeMs)) {
    if (file.mtimeMs >= Date.now() - SPILL_RETENTION_MS && total <= SPILL_DIR_LIMIT_BYTES) continue;
    await unlink(path.join(directory, file.name)).catch(() => {}); total -= file.size;
  }
}

export async function startBackgroundJob(command: string, environment: ToolEnvironment,
  shell: { executable: string; args: (command: string) => string[]; windowsVerbatimArguments?: boolean },
  options: { owner?: string; signal?: AbortSignal } = {}): Promise<JobRecord> {
  options.signal?.throwIfAborted();
  const base = path.join(environment.env.HOME ?? environment.cwd, 'shell-output');
  const directory = options.owner === undefined ? base : path.join(base, createHash('sha256').update(options.owner).digest('hex'));
  await prepareSpillDirectory(directory);
  options.signal?.throwIfAborted();
  const id = `job-${Date.now().toString(36)}-${++counter}`, logPath = path.join(directory, `${id}.log`);
  const stream = createWriteStream(logPath, { flags: 'wx' });
  // Open first: no command is spawned if its evidence cannot be persisted.
  await new Promise<void>((resolve, reject) => { stream.once('open', () => resolve()); stream.once('error', reject); });
  if (options.signal?.aborted) { stream.end(); options.signal.throwIfAborted(); }
  const child = spawn(shell.executable, shell.args(command), {
    cwd: environment.cwd, env: environment.env as NodeJS.ProcessEnv, shell: false, windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'], windowsVerbatimArguments: shell.windowsVerbatimArguments, ...processGroupOptions,
  });
  let closed!: () => void;
  const done = new Promise<void>(resolve => { closed = resolve; });
  const job: RunningJob = { id, owner: options.owner, command, pid: child.pid, startedAt: Date.now(), logPath,
    exitCode: null, finishedAt: null, child, done, bytesWritten: 0, truncated: false };
  jobs.set(id, job);
  const requestStop = () => { void stopJob(job).catch(error => { job.stopError = error; }); };
  const write = (chunk: Buffer) => {
    const remaining = JOB_SPILL_LIMIT_BYTES - job.bytesWritten;
    if (remaining <= 0) { job.truncated = true; return; }
    const part = chunk.subarray(0, remaining); job.bytesWritten += part.length;
    if (part.length < chunk.length) job.truncated = true;
    if (!stream.write(part)) { child.stdout?.pause(); child.stderr?.pause(); }
  };
  stream.on('drain', () => { child.stdout?.resume(); child.stderr?.resume(); });
  stream.on('error', () => { job.stopError = new Error('job output persistence failed'); requestStop(); });
  child.stdout?.on('data', write); child.stderr?.on('data', write);
  child.once('error', error => { write(Buffer.from(`could not run the shell: ${error.message}\n`)); });
  child.once('close', code => {
    options.signal?.removeEventListener('abort', requestStop);
    const finish = () => { job.exitCode = code; job.finishedAt = Date.now(); closed(); };
    if (stream.destroyed) finish(); else stream.end(finish);
  });
  options.signal?.addEventListener('abort', requestStop, { once: true });
  if (options.signal?.aborted) { await stopJob(job); options.signal.throwIfAborted(); }
  return job;
}

// Undefined is the legacy CLI namespace, NEVER a wildcard for desktop-owned jobs.
export function findJob(id: string, owner?: string): JobRecord | undefined {
  const job = jobs.get(id); return job?.owner === owner ? job : undefined;
}
export function listJobs(owner?: string): readonly JobRecord[] { return [...jobs.values()].filter(j => j.owner === owner); }
export function isRunning(job: JobRecord): boolean { return job.finishedAt === null; }
export async function readJobOutput(id: string, owner?: string): Promise<string> {
  const job = jobs.get(id);
  if (!job || job.owner !== owner) return `no such job: ${id}`;
  let text = '', omitted = 0;
  try {
    const file = await open(job.logPath, 'r');
    try {
      const { size } = await file.stat(); omitted = Math.max(0, size - JOB_OUTPUT_TAIL_BYTES);
      const buffer = Buffer.alloc(Math.min(size, JOB_OUTPUT_TAIL_BYTES));
      const { bytesRead } = await file.read(buffer, 0, buffer.length, omitted); text = buffer.subarray(0, bytesRead).toString('utf8');
    } finally { await file.close(); }
  } catch { /* no persisted output yet */ }
  const status = job.finishedAt === null ? 'running' : `finished with exit code ${job.exitCode}`;
  return `${job.id} (${status}): ${job.command}\n` + (omitted ? `[earlier output omitted: ${omitted} bytes]\n` : '') +
    (text || '(no output yet)') + (job.truncated ? `\n[output truncated: spill capped at ${JOB_SPILL_LIMIT_BYTES} bytes]` : '') +
    (job.stopError ? '\n[cleanup or output persistence failed; termination is not confirmed]' : '');
}
async function stopJob(job: RunningJob): Promise<void> {
  if (job.stopping) return job.stopping;
  if (job.finishedAt !== null) { if (job.stopError) throw job.stopError; return; }
  job.stopping = (async () => { await terminateProcessTree(job.child); await boundedCleanup(job.done); if (job.stopError) throw job.stopError; })();
  return job.stopping;
}
// Legacy CLI requests stop synchronously. Trusted desktop callers pass owner and await settlement.
export function killJob(id: string): boolean;
export function killJob(id: string, owner: string): Promise<boolean>;
export function killJob(id: string, owner: string | undefined): boolean | Promise<boolean>;
export function killJob(id: string, owner?: string): boolean | Promise<boolean> {
  const job = jobs.get(id), found = !!job && job.owner === owner;
  if (owner !== undefined) return found ? stopJob(job!).then(() => true) : Promise.resolve(false);
  if (!found) return false;
  void stopJob(job!).catch(error => { job!.stopError = error; }); return true;
}
export async function stopJobs(owner: string): Promise<number> {
  const owned = [...jobs.values()].filter(j => j.owner === owner && (isRunning(j) || j.stopping));
  const results = await Promise.allSettled(owned.map(stopJob));
  const failure = results.find(r => r.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return owned.length;
}
export function shutdownJobs(): number {
  const running = [...jobs.values()].filter(isRunning);
  for (const job of running) void stopJob(job).catch(error => { job.stopError = error; });
  return running.length;
}
export async function shutdownJobsAsync(): Promise<number> {
  const running = [...jobs.values()].filter(j => isRunning(j) || j.stopping);
  const results = await Promise.allSettled(running.map(stopJob));
  const failure = results.find(r => r.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return running.length;
}
