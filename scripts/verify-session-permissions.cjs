// Real Electron check for the workspace tier contract: write by default, remembered per session,
// restored after switching sessions and after restarting the client. Disposable home; no user data.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');

(async () => {
  const root = path.resolve(__dirname, '..'), home = await fs.mkdtemp(path.join(root, '.test-artifacts', 'permission-'));
  const fixtureRoot = await fs.realpath(home);
  const idA = 'desktop-chat-00000000-0000-4000-8000-00000000000a';
  const idB = 'desktop-chat-00000000-0000-4000-8000-00000000000b';
  const idC = 'desktop-chat-00000000-0000-4000-8000-00000000000c';
  const sockets = [];
  let child;

  function connect(url) {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      socket.onopen = () => {
        sockets.push(socket);
        let id = 0; const pending = new Map();
        socket.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
        resolve(async (method, params = {}) => {
          const n = ++id; let timer;
          try {
            const m = await Promise.race([
              new Promise(r => { pending.set(n, r); socket.send(JSON.stringify({ id: n, method, params })); }),
              new Promise((_, reject) => { timer = setTimeout(() => reject(Error('CDP timeout')), 15000); }),
            ]);
            assert.ok(!m.error, JSON.stringify(m)); return m.result;
          } finally { clearTimeout(timer); pending.delete(n); }
        });
      };
      socket.onerror = reject;
    });
  }

  async function boot() {
    const probe = require('node:net').createServer();
    await new Promise((resolve, reject) => { probe.once('error', reject); probe.listen(0, '127.0.0.1', resolve); });
    const debugPort = probe.address().port; await new Promise(resolve => probe.close(resolve));
    const env = { ...process.env, PERSONAL_AGENT_HOME: home }; delete env.ELECTRON_RUN_AS_NODE;
    const proc = spawn(process.execPath, ['desktop/launch.cjs', '--user-data-dir=' + path.join(home, 'electron-profile-' + debugPort),
      '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + debugPort], { cwd: root, env, stdio: 'inherit' });
    let ws;
    const evaluate = async expression => {
      const r = await ws('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
      assert.ok(!r.exceptionDetails, JSON.stringify(r)); return r.result.value;
    };
    // Fire and forget: an escalation only settles after this script clicks the dialog, so awaiting it here would deadlock.
    const fire = async expression => {
      const r = await ws('Runtime.evaluate', { expression, returnByValue: true });
      assert.ok(!r.exceptionDetails, JSON.stringify(r));
    };
    const until = async expression => { for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 100)); } throw Error('UI condition failed: ' + expression); };
    for (let i = 0; i < 100; i++) {
      try {
        const pages = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
        const page = pages.find(p => p.url.endsWith('/desktop/renderer/index.html'));
        if (page) { ws = await connect(page.webSocketDebuggerUrl); break; }
      } catch {}
      await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(ws, 'client renderer must start');
    await until(`document.querySelectorAll('.workspace-controls select').length===2`);
    return { proc, ws, evaluate, fire, until };
  }

  const tier = async evaluate => (await evaluate(`personalAgentDesktop.workspace('state')`)).data.permission;
  const log = message => console.log('[session-permissions] ' + message);
  const shown = evaluate => evaluate(`document.querySelector('.workspace-controls select').value`);
  const stored = async (id, expected) => {
    for (let i = 0; i < 60; i++) {
      try {
        const index = JSON.parse(await fs.readFile(path.join(home, 'desktop-chat-index.json'), 'utf8'));
        const entry = index.sessions.find(s => s.id === id);
        if (entry && entry.permission === expected) return entry.permission;
      } catch {}
      await new Promise(r => setTimeout(r, 50));
    }
    throw Error('index never recorded ' + String(expected) + ' for ' + id);
  };
  const fileTier = async id => JSON.parse(await fs.readFile(path.join(home, 'desktop-chat-index.json'), 'utf8')).sessions.find(s => s.id === id).permission;

  async function seed(id, title) {
    await fs.writeFile(path.join(home, id + '.jsonl'), JSON.stringify({ v: 1, kind: 'session', id, createdAt: new Date().toISOString() }) + '\n');
    await require('../desktop/chat-index.cjs').remember(home, { id, title, workspaceRoot: fixtureRoot, identity: JSON.stringify(['missing', 'http://127.0.0.1:1/v1', 'fixture', 0]) });
  }

  /** Mirrors the production path: open the session, then refresh the composer control from host state. */
  async function openSession(run, id) {
    await run.evaluate(`personalAgentDesktop.openChat(${JSON.stringify(id)})`);
    await run.evaluate(`window.dispatchEvent(new Event('workspace-sync'))`);
    await run.until(`document.querySelector('.workspace-controls select').value===${JSON.stringify(await tier(run.evaluate))}`);
  }
  /** Drives the real composer control, so the change event and not a direct IPC call performs the switch. */
  const setTier = (run, value) => run.fire(`(()=>{const s=document.querySelector('.workspace-controls select');s.value=${JSON.stringify(value)};s.dispatchEvent(new Event('change'));})()`);

  try {
    // Two sessions with no remembered tier, plus one whose stored tier is not a real tier.
    await seed(idA, 'permission fixture A');
    await seed(idB, 'permission fixture B');
    await seed(idC, 'permission fixture C');

    let run = await boot(); child = run.proc;
    log('booted; checking fresh default');
    assert.equal(await tier(run.evaluate), 'write', 'a fresh session must start at workspace write, not read-only');
    assert.equal(await shown(run.evaluate), 'write', 'the composer control must show the tier actually in force');
    assert.equal(await stored(idA, undefined), undefined, 'seeding a session must not invent a stored tier');

    // A: choose read through the real composer control; the host must remember it for A alone.
    log('opening A');
    await openSession(run, idA);
    assert.equal(await tier(run.evaluate), 'write', 'a session without a stored tier opens at the default');
    await setTier(run, 'read');
    await run.until(`document.querySelector('.workspace-controls select').value==='read'`);
    assert.equal(await stored(idA, 'read'), 'read', 'downgrading must be remembered for that session');
    assert.equal(await stored(idB, undefined), undefined, 'one session must not inherit another session tier');

    // B: escalate to full through the in-app dialog, which must be remembered too.
    log('opening B and escalating');
    await openSession(run, idB);
    assert.equal(await tier(run.evaluate), 'write', 'switching session must not leak the other session tier');
    await setTier(run, 'full');
    await run.until(`!!document.querySelector('.confirm-scrim.is-on')`);
    await run.evaluate(`document.querySelector('.confirm-actions .confirm-yes').click()`);
    await run.until(`document.querySelector('.workspace-controls select').value==='full'`);
    assert.equal(await stored(idB, 'full'), 'full', 'an accepted escalation must be remembered for that session');

    // Switching back restores each session's own tier instead of the default.
    await openSession(run, idA);
    assert.equal(await tier(run.evaluate), 'read', 'returning to a session must restore its remembered tier');
    await openSession(run, idB);
    assert.equal(await tier(run.evaluate), 'full', 'the other session keeps its own tier');
    assert.equal(await run.evaluate(`!!document.querySelector('.confirm-scrim.is-on')`), false, 'restoring a remembered tier must not re-prompt on every open');

    // Restarting the client must land on the same tier, with no fresh consent prompt.
    await run.evaluate(`personalAgentDesktop.windowAction('close')`).catch(() => {});
    for (const s of sockets.splice(0)) s.close();
    if (child.exitCode === null) child.kill();
    await new Promise(r => setTimeout(r, 1200));
    run = await boot(); child = run.proc;
    assert.equal(await tier(run.evaluate), 'write', 'a brand-new session after restart still starts at the default');
    await openSession(run, idB);
    assert.equal(await tier(run.evaluate), 'full', 'the accepted tier must survive a client restart');
    assert.equal(await run.evaluate(`!!document.querySelector('.confirm-scrim.is-on')`), false, 'a remembered tier must not re-ask after restart');
    assert.equal((await run.evaluate(`personalAgentDesktop.workspace('terminal',{command:'echo REMEMBERED FULL'})`)).ok, true, 'the restored tier must be the live tier, not only a label');
    await openSession(run, idA);
    assert.equal(await tier(run.evaluate), 'read', 'each session keeps its own tier across a restart');

    // A corrupt stored tier degrades to the default instead of guessing a stronger one.
    const raw = JSON.parse(await fs.readFile(path.join(home, 'desktop-chat-index.json'), 'utf8'));
    raw.sessions.find(s => s.id === idC).permission = 'full';
    await require('../desktop/chat-index.cjs').writeIndex(home, raw);
    const sanitized = await require('../desktop/chat-index.cjs').find(home, idC);
    assert.equal(sanitized.permission, 'full');
    raw.sessions.find(s => s.id === idC).permission = 'root';
    await require('../desktop/chat-index.cjs').writeIndex(home, raw);
    assert.equal((await require('../desktop/chat-index.cjs').find(home, idC)).permission, undefined, 'an unknown tier must be dropped by the index reader');

    const shot = await run.ws('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(root, '.test-artifacts', 'session-permission-control.png'), Buffer.from(shot.data, 'base64'));
    console.log('PASS session permissions: write by default, remembered per session, restored on switch and restart');
  } finally {
    for (const s of sockets) s.close();
    if (child && child.exitCode === null) child.kill();
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
