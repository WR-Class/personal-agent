import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, link, rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { desktopSessions, desktopHistory } from '../src/desktop-sessions.ts';
import { SessionStore } from '../src/session-store.ts';
import { readFile } from 'node:fs/promises';

test('desktop sessions: absent, filtered, bounded, read-only and hard-link refusal', async () => {
  // Windows TEMP is under protected LOCALAPPDATA; use this project's fixture root.
  const project = fileURLToPath(new URL('../', import.meta.url));
  const root = await mkdtemp(join(project, '.desktop-list-'));
  assert.ok(resolve(root).startsWith(resolve(project) + sep));
  try {
    assert.deepEqual(await desktopSessions(join(root, 'absent')), { ids: [], total: 0, truncated: false });
    assert.deepEqual(await readdir(root), []);
    await writeFile(join(root, 'provider.json'), 'secret');
    await writeFile(join(root, 'genes.jsonl'), 'private gene journal');
    await writeFile(join(root, 'cycles.jsonl'), 'private cycle journal');
    await mkdir(join(root, 'directory.jsonl'));
    await writeFile(join(root, 'bad name.jsonl'), 'not a session');
    // Listing must not parse or expose message bodies.
    await writeFile(join(root, 'chat-one.jsonl'), 'private message body');
    assert.deepEqual(await desktopSessions(root), { ids: ['chat-one'], total: 1, truncated: false });
    await link(join(root, 'chat-one.jsonl'), join(root, 'linked.jsonl'));
    await assert.rejects(desktopSessions(root), /linked or non-regular/);
    await rm(join(root, 'linked.jsonl'));
    for (let i = 0; i < 101; i++) await writeFile(join(root, `chat-${i}.jsonl`), '');
    const result = await desktopSessions(root);
    assert.equal(result.ids.length, 100);
    assert.equal(result.total, 102);
    assert.equal(result.truncated, true);
    await assert.rejects(desktopSessions(join(root, 'provider.json')));
    for (const id of [null, {}, '../escape', 'genes', 'CYCLES', 'a'.repeat(201), 'missing']) await assert.rejects(desktopHistory(root, id));
    const header = JSON.stringify({ v: 1, kind: 'session', id: 'preview', createdAt: new Date().toISOString() }) + '\n';
    const message = JSON.stringify({ v: 1, kind: 'message', at: new Date().toISOString(), message: { role: 'user', content: '<img src=x onerror=alert(1)>' } }) + '\n';
    const transcript = header + message.repeat(201);
    const file = join(root, 'preview.jsonl');
    await writeFile(file, transcript);
    const history = await desktopHistory(root, 'preview');
    assert.equal(history.messages.length, 200);
    assert.equal(history.total, 201);
    assert.equal(history.truncated, true);
    assert.equal(history.messages[0]?.content, '<img src=x onerror=alert(1)>');
    assert.equal(await readFile(file, 'utf8'), transcript);
    const bytes = Buffer.byteLength(transcript);
    assert.equal((await new SessionStore({ root, maxReadBytes: bytes }).read('preview')).length, 202);
    await assert.rejects(new SessionStore({ root, maxReadBytes: bytes - 1 }).read('preview'), /exceeds/);
    await writeFile(file, header + 'broken\n');
    await assert.rejects(desktopHistory(root, 'preview'));
    await writeFile(file, 'x'.repeat(1024 * 1024 + 1));
    await assert.rejects(desktopHistory(root, 'preview'), /exceeds/);
    await link(file, join(root, 'preview-link.jsonl'));
    await assert.rejects(desktopHistory(root, 'preview'), /linked/);
  } finally { await rm(root, { recursive: true, force: true }); }
});
