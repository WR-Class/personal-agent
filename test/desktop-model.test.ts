import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { desktopProvider, desktopModelSend } from '../src/desktop-model.ts';
import { SessionStore } from '../src/session-store.ts';
import { startTestServer } from './server-fixture.ts';

test('desktop model: explicit target, no secret DTO, real HTTP and persisted tool-free reply', async () => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const home = await mkdtemp(join(project, '.desktop-model-test-'));
  assert.ok(resolve(home).startsWith(resolve(project) + sep));
  let requests = 0, redirect = false;
  const server = await startTestServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); requests++;
    assert.equal(req.url, '/v1/chat/completions');
    assert.equal(req.headers.authorization, 'Bearer fixture-secret');
    assert.equal(body.model, 'fixture-model');
    assert.ok(!body.tools || body.tools.length === 0);
    if (redirect) { res.writeHead(307, { Location: '/not-consented' }); res.end(); return; }
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: 'fixture-model', choices: [{ message: { role: 'assistant', content: 'fixture answer' }, finish_reason: 'stop' }], usage: { prompt_tokens: 2, completion_tokens: 2 } }));
  });
  const env = { PERSONAL_AGENT_BASE_URL: `http://127.0.0.1:${server.port}/v1`, PERSONAL_AGENT_MODEL: 'fixture-model', PERSONAL_AGENT_API_KEY: 'fixture-secret' };
  try {
    await assert.rejects(desktopProvider(home, {}));
    const preview = await desktopProvider(home, env);
    assert.deepEqual(Object.keys(preview).sort(), ['baseUrl', 'model']);
    await assert.rejects(desktopModelSend(home, 'hi', { ...preview, model: 'changed' }, env));
    await assert.rejects(desktopModelSend(home, '中'.repeat(3000), preview, env));
    assert.equal(requests, 0); assert.deepEqual(await readdir(home), []);
    const result = await desktopModelSend(home, 'hello', preview, env);
    assert.equal(result.content, 'fixture answer'); assert.equal(requests, 1);
    const history = await new SessionStore({ root: home }).history(result.id);
    assert.deepEqual(history.map(m => m.role), ['user', 'assistant']);
    assert.ok(!JSON.stringify(result).includes('fixture-secret'));
    redirect = true;
    await assert.rejects(desktopModelSend(home, 'no redirect', preview, env));
    assert.equal(requests, 2, 'redirect must not issue a second request');
  } finally { await server.close(); await rm(home, { recursive: true, force: true }); }
});
