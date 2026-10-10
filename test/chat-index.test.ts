import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, writeFileSync, linkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const index = require('../desktop/chat-index.cjs');
test('chat index persists workspace, title and pending state across module reload; concurrent writes retain sessions', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'chat-index-'));
  await index.rememberWorkspace(home, home);
  const ids = Array.from({length: 4}, () => 'desktop-chat-' + randomUUID());
  await Promise.all(ids.map(id => index.remember(home, {id, title: '<script>not HTML</script>', identity: '[null,"https://example.test","m",null]', workspaceRoot: home, failed: true})));
  assert.equal(index.list(home).sessions.length, 4);
  assert.equal(index.find(home, ids[0]).failed, true);
  await index.markFailed(home, ids[0], false);
  delete require.cache[require.resolve('../desktop/chat-index.cjs')];
  const fresh = require('../desktop/chat-index.cjs');
  assert.equal(fresh.find(home, ids[0]).failed, false);
  assert.deepEqual(fresh.list(home).workspaces, [home]);
  assert.equal(fresh.find(home, ids[0]).workspaceRoot, home);
});
test('rename/pin are validated and old index shape stays unchanged; pinned order is stable', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'chat-index-'));
  const ids = Array.from({length:3}, () => 'desktop-chat-' + randomUUID());
  for (const id of ids) await index.remember(home, {id,title:'old',identity:'fixture',workspaceRoot:null,failed:false});
  const old = readFileSync(index.indexPath(home),'utf8');
  assert.equal(old.includes('pinned'),false); assert.equal(JSON.stringify(index.readIndex(home)),old);
  await index.rename(home,ids[0],'  renamed  '); assert.equal(index.find(home,ids[0]).title,'renamed');
  for (const title of ['', ' ', 'bad\nname', '\u0000', 'x'.repeat(81)]) await assert.rejects(index.rename(home,ids[0],title));
  await assert.rejects(index.rename(home,'desktop-chat-'+'-'.repeat(36),'bad'));
  await index.pin(home,ids[0],true); await index.pin(home,ids[1],true);
  assert.deepEqual(index.list(home).sessions.map((s: any)=>s.id),[ids[1],ids[0],ids[2]]);
  await index.pin(home,ids[0],false); assert.equal(Object.hasOwn(index.find(home,ids[0]),'pinned'),false);
  assert.deepEqual(index.list(home).sessions.map((s: any)=>s.id),[ids[1],ids[2],ids[0]]);
  await assert.rejects(index.pin(home,ids[0],'true'));
  await index.deleteMetadata(home,ids[1]); assert.equal(index.find(home,ids[1]),null);
  await assert.rejects(index.deleteMetadata(home,ids[1]));
});

test('a session remembers its own permission tier; legacy and invalid tiers stay absent', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'chat-index-'));
  const ids = Array.from({length: 2}, () => 'desktop-chat-' + randomUUID());
  for (const id of ids) await index.remember(home, {id, title:'t', identity:'fixture', workspaceRoot:home, failed:false});
  assert.equal(Object.hasOwn(index.find(home, ids[0]), 'permission'), false, 'no stored tier means the host default applies');
  await index.setPermission(home, ids[0], 'full');
  assert.equal(index.find(home, ids[0]).permission, 'full');
  assert.equal(index.find(home, ids[1]).permission, undefined, 'one session must not inherit another session tier');
  await index.setPermission(home, ids[0], 'read');
  assert.equal(index.find(home, ids[0]).permission, 'read');
  await assert.rejects(index.setPermission(home, ids[0], 'bogus'));
  await assert.rejects(index.setPermission(home, 'not-a-session-id', 'full'));
  assert.equal(index.find(home, ids[0]).permission, 'read', 'a rejected tier leaves the stored one untouched');
  assert.equal(await index.setPermission(home, 'desktop-chat-' + randomUUID(), 'full'), null, 'an unindexed session is a no-op');
  // A file written by an older client must still parse and gain no permission field.
  const raw = JSON.parse(readFileSync(index.indexPath(home), 'utf8'));
  for (const s of raw.sessions) delete s.permission;
  writeFileSync(index.indexPath(home), JSON.stringify(raw));
  assert.equal(JSON.stringify(index.readIndex(home)), JSON.stringify(raw), 'legacy index without tiers round-trips unchanged');
  assert.equal(index.find(home, ids[0]).permission, undefined);
});

test('corrupt or linked chat index is rejected and never overwritten', async () => {
  const home = mkdtempSync(path.join(tmpdir(), 'chat-index-'));
  const file = index.indexPath(home);
  writeFileSync(file, '{broken');
  await assert.rejects(index.rememberWorkspace(home, home));
  assert.equal(readFileSync(file, 'utf8'), '{broken');
  writeFileSync(file, JSON.stringify({version:1,workspaces:[],sessions:[]}));
  linkSync(file, path.join(home, 'hard-link'));
  await assert.rejects(index.rememberWorkspace(home, home), /unsafe/);
});
