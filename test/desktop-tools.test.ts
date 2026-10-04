import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDesktopTools } from '../src/desktop-tools.ts';
import type { DesktopToolOptions } from '../src/desktop-tools.ts';
import { desktopModelSend } from '../src/desktop-model.ts';
import { SessionStore } from '../src/session-store.ts';
import { startTestServer } from './server-fixture.ts';

const project = fileURLToPath(new URL('../', import.meta.url));
async function fixture() {
  const root = await mkdtemp(join(project, '.desktop-tools-test-'));
  const workspaceRoot = join(root, 'workspace'), home = join(root, 'home');
  await mkdir(workspaceRoot); await mkdir(home);
  return { root, workspaceRoot, home, close: () => rm(root, { recursive: true, force: true }) };
}
function harness(workspaceRoot: string, overrides: Partial<DesktopToolOptions> = {}) {
  const options: DesktopToolOptions = { workspaceRoot, writable: true, check() {}, approve: async () => true, ...overrides };
  const { tools, rules } = createDesktopTools(options);
  const execute = (name: string, args: object, extra: object = {}) => tools.execute({ id: randomUUID(), name, arguments: JSON.stringify(args) }, { workspaceRoot, rules, ...extra });
  return { tools, execute };
}

test('desktop tools: read-only has only read/list and forged writes are absent', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspaceRoot, 'note.txt'), 'hello');
    const h = harness(f.workspaceRoot, { writable: false, approve: async () => { throw Error('must never ask'); } });
    assert.deepEqual(h.tools.definitions().map(t => t.name), ['read_file', 'list_directory']);
    assert.equal((await h.execute('read_file', { path: 'note.txt' })).content, 'hello');
    assert.equal((await h.execute('create_file', { path: 'new.txt', content: 'bad' })).isError, true);
    assert.deepEqual(await readdir(f.workspaceRoot), ['note.txt']);
  } finally { await f.close(); }
});

test('desktop tools: individual approvals cannot inherit preApproval/grants; create/edit/patch reuse factories', async () => {
  const f = await fixture(); let prompts = 0;
  try {
    const h = harness(f.workspaceRoot, { approve: async () => { prompts++; return true; } });
    const extra = { preApproved: true, grants: [{ tool: 'create_file', argumentsJson: '{"path":"a.txt","content":"one"}', expiresAt: Date.now() + 50000 }] };
    assert.ok(!(await h.execute('create_file', { path: 'a.txt', content: 'one' }, extra)).isError);
    assert.ok(!(await h.execute('edit_file', { path: 'a.txt', content: 'two' }, extra)).isError);
    assert.ok(!(await h.execute('patch_file', { path: 'a.txt', oldText: 'two', newText: 'three' }, extra)).isError);
    assert.equal(prompts, 3); assert.equal(await readFile(join(f.workspaceRoot, 'a.txt'), 'utf8'), 'three');
    const denied = harness(f.workspaceRoot, { approve: async () => false });
    assert.equal((await denied.execute('edit_file', { path: 'a.txt', content: 'bad' })).isError, true);
    assert.equal(await readFile(join(f.workspaceRoot, 'a.txt'), 'utf8'), 'three');
  } finally { await f.close(); }
});

test('desktop tools: cancellation during approval and revoked roots prevent writes', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const cancelled = harness(f.workspaceRoot, { approve: async (_prompt, signal) => {
      assert.equal(signal, controller.signal); controller.abort(); return true;
    } });
    assert.equal((await cancelled.execute('create_file', { path: 'cancel.txt', content: 'bad' }, { signal: controller.signal })).isError, true);
    let valid = true;
    const revoked = harness(f.workspaceRoot, { check() { if (!valid) throw Error('revoked'); }, approve: async () => { valid = false; return true; } });
    assert.equal((await revoked.execute('create_file', { path: 'revoke.txt', content: 'bad' })).isError, true);
    assert.equal((await revoked.execute('read_file', { path: 'revoke.txt' })).isError, true);
    const already = new AbortController(); already.abort();
    assert.throws(() => harness(f.workspaceRoot, { signal: already.signal }));
    assert.deepEqual(await readdir(f.workspaceRoot), []);
  } finally { await f.close(); }
});

test('desktop tools: sensitive paths, trust roots, unrestricted flags, hardlinks and directory links are denied', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'outside.txt'), 'private');
    await writeFile(join(f.workspaceRoot, '.env'), 'secret');
    await writeFile(join(f.workspaceRoot, 'visible.txt'), 'ok');
    await link(join(f.root, 'outside.txt'), join(f.workspaceRoot, 'hardlink.txt'));
    await mkdir(join(f.workspaceRoot, 'normal'));
    await symlink(join(f.workspaceRoot, 'normal'), join(f.workspaceRoot, 'linked'), 'junction');
    const h = harness(f.workspaceRoot);
    const extra = { readableRoots: [f.root], unrestrictedWrites: true };
    assert.equal((await h.execute('read_file', { path: '../outside.txt' }, extra)).isError, true);
    assert.equal((await h.execute('create_file', { path: '../escape.txt', content: 'bad' }, extra)).isError, true);
    assert.equal((await h.execute('read_file', { path: '.env' })).isError, true);
    assert.equal((await h.execute('read_file', { path: 'hardlink.txt' })).isError, true);
    assert.equal((await h.execute('edit_file', { path: 'hardlink.txt', content: 'bad' })).isError, true);
    assert.equal((await h.execute('list_directory', { path: 'linked' })).isError, true);
    const listing = JSON.parse((await h.execute('list_directory', { path: '.' })).content);
    assert.deepEqual(listing.entries.map((e: { name: string }) => e.name).sort(), ['normal', 'visible.txt']);
  } finally { await f.close(); }
});

test('desktop tools: directory scans are capped without recursion', async () => {
  const f = await fixture();
  try {
    await Promise.all(Array.from({ length: 505 }, (_, i) => writeFile(join(f.workspaceRoot, `entry-${i}`), '')));
    const h = harness(f.workspaceRoot);
    const listing = JSON.parse((await h.execute('list_directory', { path: '.' })).content);
    assert.equal(listing.entries.length, 500); assert.equal(listing.truncated, true);
  } finally { await f.close(); }
});

test('desktop model: multistep tools, config ignored, trust root confined, transcript correlates real results', async () => {
  const f = await fixture(); let step = 0, approvals = 0;
  await writeFile(join(f.root, 'outside.txt'), 'private');
  // Runtime reads trust.json, but the desktop tools strip its extra readable roots.
  await writeFile(join(f.home, 'trust.json'), JSON.stringify({ version: 1, readableRoots: [{ root: f.root, grantedAt: new Date().toISOString() }] }));
  await writeFile(join(f.home, 'config.json'), JSON.stringify({ tier: 'full-access', rules: [{ tool: '*', decision: 'allow' }] }));
  const server = await startTestServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); step++;
    assert.deepEqual(body.tools.map((t: { function: { name: string } }) => t.function.name), ['read_file', 'list_directory', 'create_file', 'edit_file', 'patch_file']);
    const calls = step === 1 ? [{ id: 'outside', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '../outside.txt' }) } }]
      : step === 2 ? [{ id: 'create', type: 'function', function: { name: 'create_file', arguments: JSON.stringify({ path: 'answer.txt', content: 'saved' }) } }] : [];
    if (step === 3) assert.ok(body.messages.some((m: { role: string; content: string }) => m.role === 'tool' && m.content === 'created answer.txt'));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: 'fixture', choices: [{ message: { role: 'assistant', content: calls.length ? null : 'Done', ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  });
  const selected = { baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'fixture', apiKey: 'fixture-key' };
  try {
    const result = await desktopModelSend(f.home, 'create an answer', selected, {}, selected, undefined,
      { workspaceRoot: f.workspaceRoot, writable: true, check() {}, approve: async () => { approvals++; return true; } });
    assert.equal(result.error, undefined); assert.equal(result.content, 'Done'); assert.equal(step, 3); assert.equal(approvals, 1);
    assert.deepEqual(result.transcript?.map(e => [e.kind, e.callId, e.name]), [['call', 'outside', 'read_file'], ['result', 'outside', 'read_file'], ['call', 'create', 'create_file'], ['result', 'create', 'create_file']]);
    assert.equal(result.transcript?.[1]?.kind === 'result' && result.transcript[1].isError, true);
    assert.equal(await readFile(join(f.workspaceRoot, 'answer.txt'), 'utf8'), 'saved');
    assert.ok(!JSON.stringify(result).includes('fixture-key'));
  } finally { await server.close(); await f.close(); }
});

test('desktop model: eighth-argument signal cancels text-only sends without issuing HTTP', async () => {
  const f = await fixture();
  const controller = new AbortController(); controller.abort();
  const selected = { baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: 'fixture-key' };
  try {
    await assert.rejects(desktopModelSend(f.home, 'hello', selected, {}, selected, undefined, undefined, controller.signal), { name: 'AbortError' });
    assert.deepEqual(await readdir(f.home), []);
  } finally { await f.close(); }
});

test('desktop model: failure after real write returns actual transcript and keeps durable logs', async () => {
  const f = await fixture(); let step = 0;
  const server = await startTestServer(async (req, res) => {
    for await (const _ of req) { /* drain request */ }
    step++; res.setHeader('Content-Type', 'application/json');
    if (step > 1) { res.writeHead(400); res.end('{"error":"fixture"}'); return; }
    res.end(JSON.stringify({ model: 'fixture', choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'written', type: 'function', function: { name: 'create_file', arguments: '{"path":"kept.txt","content":"real"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  const selected = { baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'fixture', apiKey: 'fixture-key' };
  try {
    const result = await desktopModelSend(f.home, 'create a file', selected, {}, selected, undefined,
      { workspaceRoot: f.workspaceRoot, writable: true, check() {}, approve: async () => true });
    assert.ok(result.error); assert.equal(result.content, '');
    assert.equal(await readFile(join(f.workspaceRoot, 'kept.txt'), 'utf8'), 'real');
    assert.equal(result.transcript?.[1]?.kind === 'result' && result.transcript[1].isError, false);
    const history = await new SessionStore({ root: f.home }).history(result.id);
    assert.ok(history.some(m => m.role === 'tool' && m.content === 'created kept.txt'));
  } finally { await server.close(); await f.close(); }
});
