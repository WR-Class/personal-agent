import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm } from 'node:fs/promises';
import path from 'node:path';
import { buildToolEnvironment } from '../src/tool-environment.ts';
import { runShellCommand, shellFor, SHELL_MAX_OUTPUT_BYTES } from '../src/shell-tool.ts';
import { startBackgroundJob, findJob, listJobs, readJobOutput, killJob, stopJobs, JOB_SPILL_LIMIT_BYTES, JOB_OUTPUT_TAIL_BYTES } from '../src/background-jobs.ts';
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function fixture() {
  const root = await mkdtemp(path.join(process.cwd(), '.cancel-fixture-'));
  const home = path.join(root, 'home'), workspace = path.join(root, 'workspace');
  await mkdir(home); await mkdir(workspace);
  const environment = buildToolEnvironment({ workspaceRoot: workspace, agentHome: home });
  await writeFile(path.join(workspace, 'grandchild.cjs'), `const fs=require('node:fs');setInterval(()=>fs.appendFileSync('marker','x'),30);`);
  await writeFile(path.join(workspace, 'parent.cjs'), `require('node:child_process').spawn(process.execPath,['grandchild.cjs'],{stdio:'inherit'});setInterval(()=>{},1000);`);
  return { root, workspace, environment, command: 'node parent.cjs' };
}
async function marker(workspace: string) { return readFile(path.join(workspace, 'marker'), 'utf8').catch(() => ''); }
async function ready(workspace: string) { for (let i = 0; i < 100; i++) { if ((await marker(workspace)).length >= 2) return; await pause(30); } throw Error('fixture did not start'); }

test('quoted executable and spaced script paths preserve arguments in foreground and background', async () => {
  const f = await fixture(), owner = 'quoted-' + path.basename(f.root);
  try {
    const script = path.join(f.workspace, 'script with spaces.cjs');
    await writeFile(script, `console.log(JSON.stringify(process.argv.slice(2)));`);
    const command = `"${process.execPath}" "${script}" "argument with spaces" "a&b"`;
    const foreground = await runShellCommand(command, f.environment);
    assert.notEqual(foreground.isError, true);
    assert.match(foreground.content, /\[exit code: 0\]/);
    assert.ok(foreground.content.includes('["argument with spaces","a&b"]'));
    const job = await startBackgroundJob(command, f.environment, shellFor(), { owner });
    for (let i = 0; i < 200 && findJob(job.id, owner)!.finishedAt === null; i++) await pause(20);
    assert.equal(findJob(job.id, owner)!.exitCode, 0);
    assert.ok((await readJobOutput(job.id, owner)).includes('["argument with spaces","a&b"]'));
  } finally { await stopJobs(owner); await rm(f.root, { recursive: true, force: true }); }
});

test('foreground abort terminates shell child and grandchild before result settles', async () => {
  const f = await fixture(), controller = new AbortController();
  try {
    const running = runShellCommand(f.command, f.environment, controller.signal);
    await ready(f.workspace); controller.abort();
    const result = await running;
    assert.equal(result.isError, true); assert.match(result.content, /cancelled/); assert.doesNotMatch(result.content, /not confirmed/);
    const stopped = await marker(f.workspace); await pause(200); assert.equal(await marker(f.workspace), stopped);
    const aborted = new AbortController(); aborted.abort();
    assert.match((await runShellCommand('node parent.cjs', f.environment, aborted.signal)).content, /before spawn/);
    await pause(100); assert.equal(await marker(f.workspace), stopped);
  } finally { controller.abort(); await pause(100); await rm(f.root, { recursive: true, force: true }); }
});

test('background owner isolation and abort settlement retain no cross-owner output', async () => {
  const f = await fixture(), controller = new AbortController(), owner = 'owner-' + path.basename(f.root);
  try {
    const job = await startBackgroundJob(f.command, f.environment, shellFor(), { owner, signal: controller.signal });
    await ready(f.workspace);
    assert.equal(findJob(job.id), undefined); assert.equal(findJob(job.id, 'other'), undefined);
    assert.ok(!listJobs('other').some(j => j.id === job.id)); assert.equal(listJobs(owner).length, 1);
    assert.equal(await readJobOutput(job.id, 'other'), `no such job: ${job.id}`);
    assert.equal(await killJob(job.id, 'other'), false);
    controller.abort(); await stopJobs(owner);
    assert.notEqual(findJob(job.id, owner)!.finishedAt, null);
    const stopped = await marker(f.workspace); await pause(200); assert.equal(await marker(f.workspace), stopped);
    await assert.rejects(startBackgroundJob(f.command, f.environment, shellFor(), { owner, signal: controller.signal }), /abort/i);
    assert.equal(listJobs(owner).length, 1);
    const duringSetup = new AbortController();
    const pending = startBackgroundJob(f.command, f.environment, shellFor(), { owner, signal: duringSetup.signal });
    duringSetup.abort(); await assert.rejects(pending, /abort/i);
    assert.equal(listJobs(owner).length, 1); await pause(100); assert.equal(await marker(f.workspace), stopped);
  } finally { await stopJobs(owner); await rm(f.root, { recursive: true, force: true }); }
});

test('stopping one owner leaves another owner running, and owned kill awaits termination', async () => {
  const a = await fixture(), b = await fixture();
  const ownerA = path.basename(a.root), ownerB = path.basename(b.root);
  try {
    await startBackgroundJob(a.command, a.environment, shellFor(), { owner: ownerA });
    const jobB = await startBackgroundJob(b.command, b.environment, shellFor(), { owner: ownerB });
    await ready(a.workspace); await ready(b.workspace);
    await stopJobs(ownerA);
    const stopped = await marker(a.workspace), live = await marker(b.workspace);
    await pause(160); assert.equal(await marker(a.workspace), stopped); assert.ok((await marker(b.workspace)).length > live.length);
    assert.equal(await killJob(jobB.id, ownerB), true);
    const last = await marker(b.workspace); await pause(160); assert.equal(await marker(b.workspace), last);
  } finally { await stopJobs(ownerA); await stopJobs(ownerB); await rm(a.root, { recursive: true, force: true }); await rm(b.root, { recursive: true, force: true }); }
});

test('stdout and stderr memory and spill output are bounded', async () => {
  const f = await fixture(), owner = 'owner-' + path.basename(f.root);
  try {
    await writeFile(path.join(f.workspace, 'noise.cjs'), `process.stderr.write('e'.repeat(${JOB_SPILL_LIMIT_BYTES + 100000}));`);
    const result = await runShellCommand('node noise.cjs', f.environment);
    assert.ok(result.content.length < SHELL_MAX_OUTPUT_BYTES + 500); assert.match(result.content, /truncated/);
    const job = await startBackgroundJob('node noise.cjs', f.environment, shellFor(), { owner });
    for (let i = 0; i < 200 && findJob(job.id, owner)!.finishedAt === null; i++) await pause(20);
    assert.notEqual(findJob(job.id, owner)!.finishedAt, null);
    assert.ok((await stat(job.logPath)).size <= JOB_SPILL_LIMIT_BYTES);
    const output = await readJobOutput(job.id, owner);
    assert.ok(output.length < JOB_OUTPUT_TAIL_BYTES + 500); assert.match(output, /earlier output omitted/); assert.match(output, /spill capped/);
  } finally { await stopJobs(owner); await rm(f.root, { recursive: true, force: true }); }
});
