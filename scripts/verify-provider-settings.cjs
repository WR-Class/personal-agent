// Self-contained loopback-only desktop acceptance. PERSONAL_AGENT_ELECTRON may select an installed runtime.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
(async () => {
  const root = path.resolve(__dirname, '..'), artifacts = path.join(root, '.test-artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const home = await fs.mkdtemp(path.join(artifacts, 'provider-ui-'));
  let gets = 0, sends = 0, ws, child;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer local-fixture-only');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models' && req.method === 'GET') { gets++; res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return; }
    assert.equal(req.url, '/v1/chat/completions');
    let body = ''; for await (const c of req) body += c;
    const p = JSON.parse(body); assert.equal(p.model, 'fixture-model'); assert.ok(!p.tools?.length); sends++;
    res.end(JSON.stringify({ model: 'fixture-model', choices: [{ message: { role: 'assistant', content: 'LOCAL SETTINGS MOCK ANSWER' }, finish_reason: 'stop' }] }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(19402, '127.0.0.1', resolve); });
  let exited;
  try {
    // Never drive another user's desktop on the test port.
    let occupied = false; try { await fetch('http://127.0.0.1:9224/json/list'); occupied = true; } catch {}
    assert.equal(occupied, false, 'close the existing debug desktop before this test');
    const env = { ...process.env, PERSONAL_AGENT_HOME: home };
    for (const key of ['PERSONAL_AGENT_BASE_URL', 'PERSONAL_AGENT_MODEL', 'PERSONAL_AGENT_API_KEY', 'ELECTRON_RUN_AS_NODE']) delete env[key];
    child = spawn(process.execPath, ['desktop/launch.cjs', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9224'], { cwd: root, env, stdio: 'inherit' });
    exited = new Promise(resolve => child.once('exit', resolve));
    let page;
    for (let i = 0; i < 100 && !page; i++) {
      if (child.exitCode !== null) throw Error('desktop exited before ready');
      try { page = (await (await fetch('http://127.0.0.1:9224/json/list')).json()).find(p => p.url.endsWith('/desktop/renderer/index.html')); } catch {}
      if (!page) await new Promise(r => setTimeout(r, 100));
    }
    assert.ok(page, 'desktop startup'); ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0; const pending = new Map();
    ws.onmessage = e => { const m = JSON.parse(e.data); pending.get(m.id)?.(m); };
    async function cdp(method, params = {}) {
      const n = ++id; let timer;
      try {
        const r = await Promise.race([new Promise(resolve => { pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('CDP timeout: ' + method)), 20000); })]);
        assert.ok(!r.error, JSON.stringify(r.error)); return r.result;
      } finally { clearTimeout(timer); pending.delete(n); }
    }
    async function evaluate(expression) {
      const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value;
    }
    async function until(expression) {
      for (let i = 0; i < 100; i++) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 100)); }
      throw Error('UI condition failed: ' + expression);
    }
    await until(`typeof window.mountProviderSettings === 'function'`);
    await evaluate(`location.hash='models'`);
    await until(`Array.from(document.querySelectorAll('#setBody button')).some(b=>b.textContent==='＋ 添加模型提供商')`);
    await evaluate(`Array.from(document.querySelectorAll('#setBody button')).find(b=>b.textContent==='＋ 添加模型提供商').click()`);
    await evaluate(`Array.from(document.querySelectorAll('.provider-dialog button')).find(b=>b.textContent==='自定义模型 API').click()`);
    await evaluate(`(()=>{const inputs=document.querySelectorAll('.provider-dialog input');['fixture','本机验收','http://127.0.0.1:19402/v1','local-fixture-only'].forEach((v,i)=>inputs[i].value=v);})()`);
    await evaluate(`Array.from(document.querySelectorAll('.provider-dialog button')).find(b=>b.textContent==='获取可用模型').onclick()`);
    assert.equal(gets, 1);
    assert.ok(await evaluate(`document.querySelector('.provider-dialog').textContent.includes('fixture-model')`));
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(artifacts, 'provider-settings.png'), Buffer.from(shot.data, 'base64'));
    await evaluate(`Array.from(document.querySelectorAll('.provider-dialog button')).find(b=>b.textContent==='创建提供商').onclick()`);
    assert.equal(await evaluate(`!!document.querySelector('.provider-dialog')`), false);
    const stored = await fs.readFile(path.join(home, 'desktop-providers.json'), 'utf8');
    assert.ok(!stored.includes('local-fixture-only'), 'Electron safeStorage must encrypt the persisted key');
    await evaluate(`Array.from(document.querySelectorAll('#setBody button')).find(b=>b.textContent==='编辑').click()`);
    assert.equal(await evaluate(`document.querySelector('.provider-dialog input[type=password]').value`), '');
    await evaluate(`Array.from(document.querySelectorAll('.provider-dialog button')).find(b=>b.textContent==='获取可用模型').onclick()`);
    assert.equal(gets, 2, 'saved encrypted key reused only at original endpoint');
    // Start save, close A and open B in the same JS task. A must refresh state but never close B.
    assert.equal(await evaluate(`(async()=>{const a=document.querySelector('.provider-dialog');const done=Array.from(a.querySelectorAll('button')).find(b=>b.textContent==='保存').onclick();a.close();Array.from(document.querySelectorAll('#setBody button')).find(b=>b.textContent==='＋ 添加模型提供商').click();const b=document.querySelector('.provider-dialog[open]');await done;const alive=b.open;b.close();return alive;})()`), true);
    await evaluate(`Array.from(document.querySelectorAll('#setBody button')).find(b=>b.textContent==='编辑').click()`);
    await evaluate(`Array.from(document.querySelectorAll('.provider-dialog[open] button')).find(b=>b.textContent==='获取可用模型').onclick()`);
    assert.equal(gets, 3, 'close-during-save still refreshes revision');
    await evaluate(`document.querySelector('.provider-dialog[open]').close();document.querySelector('#setClose').click();document.querySelector('#openModel').click()`);
    await until(`!document.querySelector('#modelSend').disabled`);
    assert.ok(await evaluate(`document.querySelector('#modelTarget').textContent.includes('127.0.0.1:19402')`));
    await evaluate(`document.querySelector('#modelInput').value='local fixture only';document.querySelector('#modelSend').click()`);
    await until(`document.querySelector('#modelReply').textContent==='LOCAL SETTINGS MOCK ANSWER'`);
    assert.equal(sends, 1);
    // Reload renderer and use the saved disk profile, not in-memory input fields.
    await cdp('Page.reload'); await until(`typeof window.mountProviderSettings === 'function'`);
    await evaluate(`location.hash='models';window.dispatchEvent(new HashChangeEvent('hashchange'))`);
    await until(`Array.from(document.querySelectorAll('#setBody button')).some(b=>b.textContent==='编辑')`);
    await evaluate(`Array.from(document.querySelectorAll('#setBody button')).find(b=>b.textContent==='＋ 添加模型提供商').click()`);
    await evaluate(`(()=>{const d=document.querySelector('.provider-dialog[open]');d.querySelector('details').open=true;const i=d.querySelectorAll('input');i[0].value='local-fixture-only';i[1].value='http://127.0.0.1:19402/v1';})()`);
    await evaluate(`Array.from(document.querySelectorAll('.provider-dialog[open] button')).find(b=>b.textContent==='获取可用模型').onclick()`);
    assert.equal(gets, 4, 'preset custom URL discovery uses the specified upstream');
    await evaluate(`Array.from(document.querySelectorAll('.provider-dialog[open] button')).find(b=>b.textContent==='创建提供商').onclick()`);
    const duplicate = await evaluate(`(async()=>{const a=personalAgentDesktop,s=(await a.providerSettings('list')).data,p=s.providers.find(p=>p.id==='deepseek');return a.providerSettings('save',{revision:s.revision,provider:{...p,apiKey:'',models:[]}});})()`);
    assert.equal(duplicate.ok, false); assert.match(duplicate.error, /已存在/);
    // Exercise the real delete button with CDP accepting the native confirm dialog.
    ws.onmessage = e => { const m = JSON.parse(e.data); if(m.method==='Page.javascriptDialogOpening') ws.send(JSON.stringify({id:++id,method:'Page.handleJavaScriptDialog',params:{accept:true}})); pending.get(m.id)?.(m); };
    await cdp('Page.enable');
    await evaluate(`Array.from(document.querySelectorAll('#setBody button')).find(b=>b.textContent==='删除').onclick()`);
    const afterDelete = await evaluate(`personalAgentDesktop.providerSettings('list')`);
    assert.equal(afterDelete.data.providers.length, 1); assert.equal(afterDelete.data.providers[0].id, 'deepseek');
    console.log('PASS real Electron: both discovery tabs, encrypted save, edit/reuse, close/reopen race, reload, duplicate rejection, deletion and selected model send; GET=', gets, 'POST=', sends);
    console.log('Screenshot:', path.join(artifacts, 'provider-settings.png'));
    // Closing the renderer destroys its CDP context before Runtime.evaluate replies.
    ws.send(JSON.stringify({ id: ++id, method: 'Runtime.evaluate', params: { expression: `personalAgentDesktop.windowAction('close')` } }));
    assert.equal(await exited, 0); child = undefined;
  } finally {
    ws?.close();
    if (child && child.exitCode === null) { child.kill(); }
    await new Promise(r => server.close(r));
    // Retain the isolated fixture for inspection, never touch the real agent home.
  }
})().catch(e => { console.error(e); process.exitCode = 1; });
