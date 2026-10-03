import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, link, rm, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { desktopSessions } from '../src/desktop-sessions.ts';

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
  } finally { await rm(root, { recursive: true, force: true }); }
});
