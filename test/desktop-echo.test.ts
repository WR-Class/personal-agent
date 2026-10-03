import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { desktopEcho } from '../src/desktop-echo.ts';
import { SessionStore } from '../src/session-store.ts';

test('explicit offline turn validates before writing and persists a fresh tool-free conversation', async () => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const home = await mkdtemp(join(project, '.desktop-echo-test-'));
  assert.ok(resolve(home).startsWith(resolve(project) + sep));
  try {
    for (const input of [undefined, {}, '', '  ', '中'.repeat(3000), 'x'.repeat(8193)]) await assert.rejects(desktopEcho(home, input));
    assert.deepEqual(await readdir(home), []);
    const result = await desktopEcho(home, '<img src=x> hello');
    assert.match(result.id, /^desktop-echo-/);
    assert.equal(result.mode, 'offline-echo');
    assert.equal(result.content, 'echo: <img src=x> hello');
    const store = new SessionStore({ root: home });
    const history = await store.history(result.id);
    assert.deepEqual(history.map(m => m.role), ['user', 'assistant']);
    assert.equal(history[0]?.content, '<img src=x> hello');
    assert.ok(history.every(m => !m.toolCalls?.length));
    assert.notEqual((await desktopEcho(home, 'second')).id, result.id);
  } finally { await rm(home, { recursive: true, force: true }); }
});
