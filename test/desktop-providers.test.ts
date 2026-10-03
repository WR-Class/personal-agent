import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, link, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { DesktopProviders } from '../src/desktop-providers.ts';
import { startTestServer } from './server-fixture.ts';

test('desktop providers: discovery, encrypted DTO, revisions, edits, links and upstream failures', async () => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const home = await mkdtemp(join(project, '.desktop-providers-test-'));
  assert.ok(resolve(home).startsWith(resolve(project) + sep));
  // Reversible test codec only; production passes Electron safeStorage.
  const crypto = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v.split('').reverse().join('')), decryptString: (v: Buffer) => v.toString().split('').reverse().join('') };
  let mode = 'ok', requests = 0;
  const server = await startTestServer((req, res) => {
    requests++; assert.equal(req.url, '/v1/models'); assert.equal(req.headers.authorization, 'Bearer fixture-secret');
    if (mode === 'redirect') { res.writeHead(302, { Location: '/other' }); res.end(); }
    else if (mode === 'auth') { res.writeHead(401); res.end('fixture-secret'); }
    else if (mode === 'large') res.end('x'.repeat(262145));
    else res.end(JSON.stringify({ data: [{ id: 'one' }, { id: 'two' }, { id: 'one' }] }));
  });
  const store = new DesktopProviders(home, crypto), file = join(home, 'desktop-providers.json');
  const provider = { id: 'fixture', name: 'Fixture', kind: 'custom', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fixture-secret', models: ['one'] };
  try {
    assert.deepEqual((await store.list()).providers, []);
    await assert.rejects(store.save({ revision: 'empty', provider: { ...provider, apiKey: '密'.repeat(3000) } }), /密钥无效/);
    assert.deepEqual(await store.discover({ revision: 'empty', provider }), { models: ['one', 'two'] });
    let state = await store.save({ revision: 'empty', provider });
    assert.equal(state.providers[0]!.hasKey, true);
    assert.ok(!JSON.stringify(state).includes('secret'));
    assert.ok(!(await readFile(file, 'utf8')).includes('fixture-secret'));
    assert.equal((await store.resolve('fixture', 'one')).apiKey, 'fixture-secret');
    await assert.rejects(store.save({ revision: 'empty', provider }), /配置已变化/);
    await assert.rejects(store.save({ revision: state.revision, editingId: 'fixture', provider: { ...provider, apiKey: '', baseUrl: 'https://example.com/v1' } }), /重新输入密钥/);
    await assert.rejects(store.save({ revision: state.revision, provider: { ...provider, apiKey: '', models: [] } }), /已存在/);
    assert.deepEqual((await store.list()).providers[0]!.models, ['one']);
    const oldRevision = state.revision;
    state = await store.save({ revision: state.revision, editingId: 'fixture', provider: { ...provider, apiKey: '', name: 'Renamed' } });
    await assert.rejects(store.resolve('fixture', 'one', oldRevision), /配置已变化/);
    assert.equal((await store.resolve('fixture', 'one')).apiKey, 'fixture-secret');
    for (const m of ['redirect', 'auth', 'large']) {
      mode = m; const before = requests;
      await assert.rejects(store.discover({ revision: state.revision, editingId: 'fixture', provider }), e => e instanceof Error && !e.message.includes('fixture-secret'));
      assert.equal(requests, before + 1);
    }
    const unavailable = new DesktopProviders(home, { ...crypto, isEncryptionAvailable: () => false });
    await assert.rejects(unavailable.save({ revision: state.revision, editingId: 'fixture', provider }), /拒绝明文/);
    await link(file, join(home, 'alias'));
    await assert.rejects(store.list(), /不安全/);
    await unlink(join(home, 'alias'));
    await writeFile(file + '.lock', 'fixture', { flag: 'wx' });
    await assert.rejects(store.delete({ revision: state.revision, id: 'fixture' }), /配置正在修改/);
    await unlink(file + '.lock');
    state = await store.delete({ revision: state.revision, id: 'fixture' });
    assert.deepEqual(state.providers, []);
    await assert.rejects(store.resolve('fixture', 'one'));
  } finally { await server.close(); await rm(home, { recursive: true, force: true }); }
});
