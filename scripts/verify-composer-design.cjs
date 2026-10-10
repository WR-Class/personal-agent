// Actual isolated Electron mouse/keyboard acceptance; loopback fixtures only, never the user's app.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const { spawn } = require('node:child_process');
(async () => {
  const root = path.resolve(__dirname, '..'), artifacts = path.join(root, '.test-artifacts');
  await fs.mkdir(artifacts, { recursive: true });
  const home = await fs.mkdtemp(path.join(artifacts, 'composer-design-'));
  const models = ['Alpha Vision Pro', 'beta Reasoning', ...Array.from({ length: 16 }, (_, i) => `Long model ${String(i + 1).padStart(2, '0')} · reasoning vision enterprise extended context 128K 超长模型名称` ), '<img src=x onerror="window.pickerInjected=1">'];
  const requests = []; let includeUsage = true;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models') { res.end(JSON.stringify({ data: models.map(id => ({ id })) })); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); assert.ok(models.includes(body.model)); requests.push(body);
    res.end(JSON.stringify({ model: body.model, ...(includeUsage ? { usage: { prompt_tokens: 1000, completion_tokens: 100, total_tokens: 1100, prompt_tokens_details: { cached_tokens: 900 } } } : {}), choices: [{ message: { role: 'assistant', content: 'COMPOSER FIXTURE ANSWER' }, finish_reason: 'stop' }] }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const probe = net.createServer(); await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  let child, ws, cdp, evaluate;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  try {
    const env = { ...process.env, PERSONAL_AGENT_HOME: home };
    for (const key of ['PERSONAL_AGENT_BASE_URL', 'PERSONAL_AGENT_MODEL', 'PERSONAL_AGENT_API_KEY', 'ELECTRON_RUN_AS_NODE']) delete env[key];
    child = spawn(process.execPath, ['desktop/launch.cjs', '--user-data-dir=' + path.join(home, 'profile'), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port], { cwd: root, env, stdio: 'inherit' });
    let page;
    for (let i = 0; i < 120 && !page; i++) {
      if (child.exitCode !== null) throw Error('isolated desktop exited');
      try { page = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p => p.url.endsWith('/desktop/renderer/index.html')); } catch {}
      if (!page) await pause(100);
    }
    assert.ok(page, 'isolated desktop ready'); ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    let id = 0, chooser; const pending = new Map(); ws.onmessage = e => { const message = JSON.parse(e.data); if (message.method === 'Page.fileChooserOpened') chooser = message.params; pending.get(message.id)?.(message); };
    cdp = async (method, params = {}) => {
      const n = ++id; let timer;
      try {
        const message = await Promise.race([new Promise(resolve => { pending.set(n, resolve); ws.send(JSON.stringify({ id: n, method, params })); }), new Promise((_, reject) => { timer = setTimeout(() => reject(Error('CDP timeout ' + method)), 20000); })]);
        assert.ok(!message.error, JSON.stringify(message.error)); return message.result;
      } finally { clearTimeout(timer); pending.delete(n); }
    };
    evaluate = async expression => { const r = await cdp('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails)); return r.result.value; };
    async function until(expression) { for (let i = 0; i < 120; i++) { if (await evaluate(expression)) return; await pause(75); } throw Error('UI condition: ' + expression); }
    async function click(selector) {
      const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})()`);
      assert.ok(point?.w > 0 && point.h > 0, 'visible clickable ' + selector);
      await cdp('Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
      await cdp('Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
    }
    async function key(name) {
      const codes = { Escape: 27, Tab: 9, ArrowDown: 40, ArrowUp: 38, Enter: 13, Home: 36, End: 35 };
      await cdp('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code: name, windowsVirtualKeyCode: codes[name], nativeVirtualKeyCode: codes[name] });
      await cdp('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code: name, windowsVirtualKeyCode: codes[name], nativeVirtualKeyCode: codes[name] });
    }
    async function search(text) { await click('.picker-popover:popover-open .picker-search'); await evaluate(`document.activeElement.value='';document.activeElement.dispatchEvent(new Event('input',{bubbles:true}))`); await cdp('Input.insertText', { text }); }
    async function screenshot(tag) { await cdp('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 10, y: 35 }); await until(`!document.querySelector('#toast.is-on')`); await pause(180); const result = await cdp('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(artifacts, `composer-design-${tag}.png`), Buffer.from(result.data, 'base64')); }
    async function geometry() {
      assert.ok(await evaluate(`(()=>{const p=document.querySelector('.picker-popover:popover-open'),r=p?.getBoundingClientRect();if(!r)return false;const hit=document.elementFromPoint(r.left+r.width/2,r.top+Math.min(25,r.height/2));return r.left>=0&&r.top>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&p.contains(hit)&&p.scrollWidth<=p.clientWidth+1;})()`), 'top-layer is hit-testable, fits viewport and does not overflow horizontally');
    }
    const model = '#vHome .agent-picker[data-kind="model"]', permission = '#vHome .agent-picker[data-kind="permission"]';
    await until(`document.querySelectorAll('.agent-picker').length===4&&!document.querySelector('#btnNew').disabled`);
    const initial = await evaluate(`personalAgentDesktop.providerSettings('list')`);
    const saved = await evaluate(`personalAgentDesktop.providerSettings('save',${JSON.stringify({ revision: initial.data.revision, provider: { id: 'design', name: '本地设计验收', kind: 'custom', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'fixture-only', models } })})`);
    assert.equal(saved.ok, true);
    const fixtureId = 'desktop-chat-00000000-0000-4000-8000-000000000099', workspace = await fs.realpath(home);
    await fs.writeFile(path.join(home, fixtureId + '.jsonl'), JSON.stringify({ v: 1, kind: 'session', id: fixtureId, createdAt: new Date().toISOString() }) + '\n');
    await require('../desktop/chat-index.cjs').remember(home, { id: fixtureId, title: 'picker fixture', workspaceRoot: workspace, identity: JSON.stringify(['design', `http://127.0.0.1:${server.address().port}/v1`, models[0], saved.data.revision]) });
    await evaluate(`personalAgentDesktop.openChat(${JSON.stringify(fixtureId)}).then(()=>personalAgentDesktop.resetChat())`);
    await evaluate(`window.dispatchEvent(new Event('providers-changed'));window.dispatchEvent(new Event('workspace-sync'))`);
    await until(`document.querySelector('#taHomeModel').options.length>=20`);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    assert.ok(await evaluate(`getComputedStyle(document.querySelector('#taHomeModel')).display==='none'`), 'native model select is hidden state only');
    await click(model); await until(`!!document.querySelector('.picker-popover:popover-open')`); await geometry();
    assert.equal(await evaluate(`document.querySelectorAll('.picker-popover:popover-open [role=option]').length`), 20);
    assert.equal(await evaluate(`document.querySelector('.picker-popover:popover-open .picker-options').getAttribute('role')`), 'listbox');
    assert.equal(await evaluate(`document.querySelectorAll('.picker-popover:popover-open img').length`), 0, 'untrusted model markup remains text');
    assert.ok(await evaluate(`document.querySelector('.picker-popover:popover-open').textContent.includes('<img src=x')`));
    await screenshot('model-light');
    await search('ALPHA'); await until(`document.querySelectorAll('.picker-popover:popover-open [role=option]').length===1`);
    await key('ArrowDown'); await key('Enter');
    await until(`!document.querySelector('.picker-popover:popover-open')&&document.querySelector('#taHomeModel').value.includes('Alpha Vision Pro')`);
    assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(model)})`), true, 'Enter returns focus to model trigger');
    assert.equal(await evaluate(`document.querySelector('#taHomeModel').value===document.querySelector('#taChatModel').value`), true);
    await click(model); await until(`!!document.querySelector('.picker-popover:popover-open')`);
    assert.equal(await evaluate(`document.querySelectorAll('.picker-popover:popover-open [role=option][aria-selected=true]').length`), 1);
    await search('NO SUCH MODEL 999'); assert.equal(await evaluate(`document.querySelectorAll('.picker-popover:popover-open [role=option]').length`), 0);
    assert.ok(await evaluate(`document.querySelector('.picker-popover:popover-open').textContent.trim().length>0`), 'empty search has feedback');
    await key('Escape'); await until(`!document.querySelector('.picker-popover:popover-open')`);
    assert.equal(await evaluate(`document.activeElement===document.querySelector(${JSON.stringify(model)})`), true);
    await click(model); await until(`!!document.querySelector('.picker-popover:popover-open')`); await key('Tab');
    await until(`!document.querySelector('.picker-popover:popover-open')`);
    assert.ok(await evaluate(`document.activeElement!==document.body&&!document.activeElement.closest('.picker-popover')`), 'Tab leaves popup into normal document focus');
    await click(permission); await until(`!!document.querySelector('.picker-popover:popover-open')`); await geometry();
    assert.match(await evaluate(`document.querySelector('.picker-popover:popover-open').textContent`), /无系统沙箱/);
    await screenshot('permission-light');
    await click('.picker-popover:popover-open [role=option]:nth-child(2)');
    await until(`document.querySelector('.workspace-controls select').value==='write'&&!document.querySelector('.agent-picker[data-kind=permission]').disabled`);
    assert.equal((await evaluate(`personalAgentDesktop.workspace('state')`)).data.permission, 'write');
    await click(permission); await until(`!!document.querySelector('.picker-popover:popover-open')`);
    await click('.picker-popover:popover-open [role=option]:nth-child(3)'); await until(`!!document.querySelector('.confirm-scrim.is-on')`);
    assert.match(await evaluate(`document.querySelector('.confirm-detail').textContent`), /没有操作系统沙箱/);
    await click('.confirm-actions button:first-child');
    await until(`!document.querySelector('.confirm-scrim.is-on')&&document.querySelector('.workspace-controls select').value==='write'`);
    assert.equal((await evaluate(`personalAgentDesktop.workspace('state')`)).data.permission, 'write');
    assert.match(await evaluate(`document.querySelector(${JSON.stringify(permission)}).textContent`), /工作区写入/);
    const styles = await evaluate(`Array.from(document.querySelectorAll('#vHome .agent-picker')).map(e=>({height:e.getBoundingClientRect().height,font:getComputedStyle(e).fontSize,family:getComputedStyle(e).fontFamily}))`);
    assert.equal(styles[0].height, styles[1].height); assert.equal(styles[0].font, styles[1].font); assert.equal(styles[0].family, styles[1].family);
    await evaluate(`document.documentElement.setAttribute('data-theme','dark')`); await click(model); await until(`!!document.querySelector('.picker-popover:popover-open')`); await geometry(); await screenshot('model-dark'); await key('Escape');
    await evaluate(`document.documentElement.setAttribute('data-theme','light')`);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false });
    await until(`(()=>{const r=document.querySelector('#vHome .composer').getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1;})()`);
    await pause(250); // Let the responsive sidebar transition settle before capturing geometry.
    assert.ok(await evaluate(`(()=>{const e=document.querySelector('#vHome .composer');return e.scrollWidth<=e.clientWidth+1;})()`), 'narrow composer has no horizontal overflow');
    await click(model); await until(`!!document.querySelector('.picker-popover:popover-open')`); await geometry(); await screenshot('narrow'); await key('Escape');
    // Existing-chat model transfer must still roll back BOTH native state and visible trigger when denied.
    await click('#taHome'); await cdp('Input.insertText', { text: 'fixture hello' }); await click('#sendHome');
    await until(`document.querySelector('#liveChatList').textContent.includes('COMPOSER FIXTURE ANSWER')&&!document.querySelector('#sendChat').disabled`);
    await until(`document.querySelector('#sendChat').dataset.action==='send'`);
    const metric = async key => evaluate(`document.querySelector('.composer-usage [data-metric=${key}]').textContent`);
    async function checkUsage(turns, total) {
      assert.match(await metric('turns'), new RegExp(`${turns}\\s*轮\\s*${turns}\\s*步`));
      assert.equal(await metric('tokens'), total + ' tok');
      assert.match(await metric('speed'), /^\d+(?:\.\d+)? tok\/s$/);
      assert.equal(await metric('cache'), '缓存命中 90%'); assert.equal(await metric('context'), '上下文 —');
    }
    async function usageGeometry() {
      assert.ok(await evaluate(`(()=>{const u=document.querySelector('.composer-usage'),c=u.closest('.composer'),r=u.getBoundingClientRect(),s=c.querySelector('.slot').getBoundingClientRect();return u.getAttribute('role')==='status'&&!c.querySelector('.composer-status')&&!document.querySelector('#sbTokens')&&document.querySelector('#chatScroll>.composer-status')&&r.top>=s.bottom&&Math.abs((r.left+r.right)-(s.left+s.right))<2&&r.bottom<=innerHeight&&getComputedStyle(u).justifyContent==='center';})()`),'usage is centered below input card, not window/footer; operational status stays in chat scroll');
      assert.match(await evaluate(`document.querySelector('[data-metric=speed]').title`), /网络.*等待/);
      assert.match(await evaluate(`document.querySelector('[data-metric=tokens]').title`), /累计输入.*输出/);
    }
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await checkUsage(1, '1.1K'); await usageGeometry();
    const usageChatId = (await evaluate(`personalAgentDesktop.listChats()`)).activeSessionId;
    await screenshot('usage');
    const before = await evaluate(`document.querySelector('#taChatModel').value`);
    await click('#vChat .agent-picker[data-kind="model"]'); await until(`!!document.querySelector('.picker-popover:popover-open')`); await search('BETA'); await key('ArrowDown'); await key('Enter');
    await until(`!!document.querySelector('.confirm-scrim.is-on')`); await click('.confirm-actions button:first-child');
    await until(`!document.querySelector('.confirm-scrim.is-on')&&!document.querySelector('#taChatModel').disabled`);
    assert.equal(await evaluate(`document.querySelector('#taChatModel').value`), before);
    assert.match(await evaluate(`document.querySelector('#vChat .agent-picker[data-kind=model]').textContent`), /Alpha Vision Pro/);
    assert.equal(await evaluate(`window.pickerInjected===1`), false);
    await cdp('Emulation.setDeviceMetricsOverride', { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    const plus = '#vChat .slot-bar [title="添加文件"]';
    assert.ok(await evaluate(`document.querySelector('#vChat .workspace-choose').offsetParent===null`), 'chat has no visible folder selector');
    assert.ok(await evaluate(`(()=>{const p=document.querySelector('#vChat .agent-picker[data-kind=permission]'),a=document.querySelector(${JSON.stringify(plus)}),m=document.querySelector('#vChat .agent-picker[data-kind=model]'),s=document.querySelector('#sendChat');const r=[a,p,m,s].map(e=>e.getBoundingClientRect());return p.closest('.slot-bar')&&r[0].right<=r[1].left+2&&r[1].right<r[2].left&&r[2].right<=r[3].left+2&&r.every(n=>Math.abs(n.top-r[0].top)<5);})()`), 'one chat toolbar aligns plus/permission left and model/send right');
    assert.ok(await evaluate(`(()=>{const e=document.querySelector('#vChat .workspace-controls');return e.classList.contains('workspace-controls--inline')&&getComputedStyle(e).borderTopWidth==='0px';})()`), 'no chat bottom divider row');
    const actions = '.composer-actions-popover[data-composer="taChat"]';
    await click(plus); await until(`document.querySelector(${JSON.stringify(actions)}).matches(':popover-open')`);
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll(${JSON.stringify(actions + ' .composer-action')})).map(e=>e.dataset.command)`), ['file'], 'plus contains only file attachment; fixed model and permission controls are not duplicated');
    await screenshot('actions');
    await key('Escape');
    await click('#vChat .agent-picker[data-kind=model]'); await until(`!!document.querySelector('.picker-popover:popover-open[data-kind=model]')`); await key('Escape');
    await click('#vChat .agent-picker[data-kind=permission]'); await until(`!!document.querySelector('.picker-popover:popover-open[data-kind=permission]')`); await key('Escape');
    await cdp('Page.enable'); await cdp('Page.setInterceptFileChooserDialog', { enabled: true });
    async function addFile(filename, content) {
      const filePath = path.join(home, filename); await fs.writeFile(filePath, content); chooser = null;
      await click(plus); await click(actions + ' [data-command=file]');
      for (let i=0;i<80&&!chooser;i++) await pause(50);
      assert.ok(chooser?.backendNodeId, 'native file chooser interception');
      await cdp('DOM.setFileInputFiles', { backendNodeId: chooser.backendNodeId, files: [filePath] });
    }
    const chips = '#vChat .composer-file-chip';
    await addFile('context.txt', 'ATTACHMENT_SENTINEL_中文'); await until(`document.querySelectorAll(${JSON.stringify(chips)}).length===1`);
    assert.match(await evaluate(`document.querySelector(${JSON.stringify(chips)}).textContent`), /context.txt/);
    await screenshot('chat');
    await click(chips + ' button'); await until(`document.querySelectorAll(${JSON.stringify(chips)}).length===0`);
    for (const [filename, contents] of [['binary.txt',Buffer.from([65,0,66])],['invalid.txt',Buffer.from([0xc3,0x28])],['image.png',Buffer.from([137,80,78,71])],['large.txt','x'.repeat(5000)]]) {
      await addFile(filename,contents);
      await until(`document.querySelector('#vChat .composer-status').textContent.length>0`);
      await pause(120); assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(chips)}).length`),0,'unsupported or overlimit file rejected: '+filename);
    }
    await addFile('context.txt', 'ATTACHMENT_SENTINEL_中文'); await until(`document.querySelectorAll(${JSON.stringify(chips)}).length===1`);
    await click('#taChat'); await cdp('Input.insertText',{text:'x'.repeat(8190)}); const beforeOversize=requests.length;
    await click('#sendChat'); await until(`document.querySelector('#vChat .composer-status').textContent.includes('8192')`);
    assert.equal(requests.length,beforeOversize,'combined oversized prompt never reaches provider');
    assert.equal(await evaluate(`document.querySelector('#taChat').value.length`),8190,'oversized draft preserved');
    assert.equal(await evaluate(`document.querySelectorAll(${JSON.stringify(chips)}).length`),1,'oversized attachment retained');
    await evaluate(`document.querySelector('#taChat').value='';document.querySelector('#taChat').dispatchEvent(new Event('input',{bubbles:true}))`);
    await click('#sendChat'); await until(`!document.querySelector('#sendChat').disabled&&document.querySelector('#sendChat').dataset.action==='send'&&document.querySelectorAll(${JSON.stringify(chips)}).length===0`);
    assert.equal(requests.length,beforeOversize+1,'file-only send issues exactly one model request: '+await evaluate(`document.querySelector('#vChat .composer-status').textContent+' | '+document.querySelector('#liveChatList').textContent.slice(-1200)`));
    const sent=requests.at(-1).messages.filter(m=>m.role==='user').at(-1).content;
    assert.match(sent,/context\.txt/); assert.match(sent,/ATTACHMENT_SENTINEL_中文/);
    await checkUsage(2, '2.2K');
    await cdp('Emulation.setDeviceMetricsOverride', { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }); await pause(250); await usageGeometry();
    await cdp('Emulation.clearDeviceMetricsOverride');
    await click('#btnNew'); await until(`!document.querySelector('#btnNew').disabled`);
    assert.match(await metric('turns'), /0\s*轮\s*0\s*步/); assert.match(await metric('tokens'), /^— tok/);
    await until(`!!document.querySelector('.session-row[data-session="${usageChatId}"]')`);
    await click(`.session-row[data-session="${usageChatId}"]`); await until(`!document.querySelector('#btnNew').disabled&&document.querySelector('#liveChatList').textContent.includes('ATTACHMENT_SENTINEL')`);
    await checkUsage(2, '2.2K'); await usageGeometry();
    includeUsage = false;
    await click('#taChat'); await cdp('Input.insertText', {text:'usage missing on next turn'}); await click('#sendChat');
    await until(`document.querySelector('#sendChat').dataset.action==='send'&&!document.querySelector('#btnNew').disabled`);
    assert.match(await metric('turns'), /3\s*轮\s*3\s*步/); assert.match(await metric('tokens'), /^2\.2K tok \*/);
    assert.equal(await metric('speed'), '— tok/s');
    assert.match(await evaluate(`document.querySelector('[data-metric=tokens]').title`), /不完整/);
    await click('#btnNew'); await until(`!document.querySelector('#btnNew').disabled`);
    await click('#taHome'); await cdp('Input.insertText', {text:'entire conversation has no provider usage'}); await click('#sendHome');
    await until(`document.querySelector('#sendChat').dataset.action==='send'&&!document.querySelector('#btnNew').disabled&&document.querySelector('#liveChatList').textContent.includes('COMPOSER FIXTURE ANSWER')`);
    assert.match(await metric('turns'), /1\s*轮\s*1\s*步/); assert.match(await metric('tokens'), /^— tok/);
    assert.equal(await metric('speed'), '— tok/s'); assert.equal(await metric('cache'), '缓存命中 —'); assert.equal(await metric('context'), '上下文 —');
    await usageGeometry();
    console.log('PASS real usage: centered below composer, 1.1K -> 2.2K accumulated, native reopen preserved, reset cleared, missing usage stays unknown and partial totals marked');
    console.log('PASS composer design: native picker input/keyboard, rollback, themes/narrow; inline chat permissions, file-only plus menu without duplicate selectors, native file chooser, removal, binary/image/size refusals, draft-preserving total limit and real HTTP file-only prompt');
  } finally {
    try { if (evaluate) await evaluate(`personalAgentDesktop.windowAction('close')`); } catch {}
    ws?.close(); if (child && child.exitCode === null) child.kill(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
