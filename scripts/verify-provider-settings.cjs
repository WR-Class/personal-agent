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
  const prompts = []; let failChat = false, toolScenario = null, toolStep = 0, probeMode = null, probeRequests = 0, finishProbe;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer local-fixture-only');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models' && req.method === 'GET') { gets++; res.end(JSON.stringify({ data: [{ id: 'fixture-model' }] })); return; }
    assert.equal(req.url, '/v1/chat/completions');
    let body = ''; for await (const c of req) body += c;
    const p = JSON.parse(body); assert.equal(p.model, 'fixture-model'); sends++;
    if (probeMode) {
      probeRequests++;
      assert.equal(p.messages.length,1); assert.match(p.messages[0].content,/synthetic fixture/);
      assert.deepEqual(p.tools.map(t=>t.function.name),['list_directory']);
      const outcome = probeMode;
      finishProbe = () => {
        if (outcome === 'error') { res.writeHead(503); res.end('{}'); return; }
        const message = outcome === 'good' ? {role:'assistant',content:'',tool_calls:[{id:'probe',type:'function',function:{name:'list_directory',arguments:'{"path":"."}'}}]} : {role:'assistant',content:'Only read_tabular and system_todo_write are available <script>bad()</script>'};
        res.end(JSON.stringify({model:'fixture-model',choices:[{message,finish_reason:outcome==='good'?'tool_calls':'stop'}]}));
      };
      return;
    }
    if (toolScenario) {
      assert.ok(p.tools.some(t=>t.function.name==='read_file'));
      assert.ok(!p.tools.some(t=>t.function.name==='run_command'));
      const call = toolScenario[toolStep++];
      const message = call ? {role:'assistant',content:null,tool_calls:[{id:'tool-'+toolStep,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]} : {role:'assistant',content:'MODEL FILE TOOLS DONE'};
      res.end(JSON.stringify({model:'fixture-model',choices:[{message,finish_reason:call?'tool_calls':'stop'}]})); return;
    }
    assert.ok(!p.tools?.length);
    prompts.push(p.messages);
    if (failChat) { res.writeHead(503); res.end('{}'); return; }
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
    child = spawn(process.execPath, ['desktop/launch.cjs', '--user-data-dir=' + path.join(home, 'electron-profile'), '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=9224'], { cwd: root, env, stdio: 'inherit' });
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
    assert.equal(await evaluate(`!!document.querySelector('#panel,#savedSessions,#refreshSessions') || document.querySelector('#taskGroups').children.length>0`), false);
    await until(`!!document.querySelector('#workspaceToggle')`);
    assert.equal((await evaluate(`personalAgentDesktop.workspace('state')`)).data.permission, 'read');
    assert.equal((await evaluate(`personalAgentDesktop.workspace('terminal',{command:'echo forbidden'})`)).ok, false);
    assert.equal((await evaluate(`personalAgentDesktop.workspace('browser-open',{url:'file:///C:/Windows/win.ini'})`)).ok, false);
    await evaluate(`document.querySelector('#workspaceToggle').click()`);
    await until(`document.querySelectorAll('.workspace-start button').length===3`);
    const toolShot = await cdp('Page.captureScreenshot', {format:'png'}); await fs.writeFile(path.join(artifacts,'workspace-panel.png'),Buffer.from(toolShot.data,'base64'));
    await evaluate(`document.querySelector('#workspaceToggle').click()`);
    assert.ok(await evaluate(`(()=>{const s=document.querySelector('#sendHome').getBoundingClientRect(),m=document.querySelector('#taHomeModel').getBoundingClientRect(),w=document.querySelector('.workspace-controls').getBoundingClientRect();return m.right<=s.left+2&&w.top>=s.bottom;})()`),'model before send and workspace below composer');
    async function checkProviderLayout(width, tag) {
      await cdp('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
      assert.ok(await evaluate(`(()=>{const d=document.querySelector('.provider-dialog[open]'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth+1&&Array.from(d.querySelectorAll('button')).every(b=>{const s=getComputedStyle(b);return b.clientHeight>=parseFloat(s.paddingTop)+parseFloat(s.paddingBottom)+parseFloat(s.lineHeight)});})()`), 'dialog and buttons fit '+width);
      const image = await cdp('Page.captureScreenshot', { format: 'png' });
      await fs.writeFile(path.join(artifacts, tag+'-'+width+'.png'), Buffer.from(image.data,'base64'));
    }
    await evaluate(`location.hash='models'`);
    await until(`Array.from(document.querySelectorAll('#setBody button')).some(b=>b.textContent==='＋ 添加模型提供商')`);
    await evaluate(`Array.from(document.querySelectorAll('#setBody button')).find(b=>b.textContent==='＋ 添加模型提供商').click()`);
    await checkProviderLayout(1440, 'provider-third'); await checkProviderLayout(520, 'provider-third');
    await evaluate(`Array.from(document.querySelectorAll('.provider-dialog button')).find(b=>b.textContent==='自定义模型 API').click()`);
    await checkProviderLayout(520, 'provider-custom'); await checkProviderLayout(1440, 'provider-custom');
    await evaluate(`(()=>{const inputs=document.querySelectorAll('.provider-dialog input');['fixture','本机验收','http://127.0.0.1:19402/v1','local-fixture-only'].forEach((v,i)=>inputs[i].value=v);})()`);
    await evaluate(`Array.from(document.querySelectorAll('.provider-dialog button')).find(b=>b.textContent==='获取可用模型').onclick()`);
    assert.equal(gets, 1);
    assert.ok(await evaluate(`document.querySelector('.provider-dialog').textContent.includes('fixture-model')`));
    const shot = await cdp('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(artifacts, 'provider-settings.png'), Buffer.from(shot.data, 'base64'));
    await evaluate(`Array.from(document.querySelectorAll('.provider-dialog button')).find(b=>b.textContent==='创建提供商').onclick()`);
    assert.equal(await evaluate(`!!document.querySelector('.provider-dialog')`), false);
    assert.ok(await evaluate(`Array.from(document.querySelectorAll('#setBody button')).every(b=>{const s=getComputedStyle(b);return b.clientHeight>=parseFloat(s.paddingTop)+parseFloat(s.paddingBottom)+parseFloat(s.lineHeight)})`), 'provider list button text fits its border');
    const listShot = await cdp('Page.captureScreenshot', { format: 'png' }); await fs.writeFile(path.join(artifacts,'provider-list.png'), Buffer.from(listShot.data,'base64'));
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
    assert.ok(await evaluate(`document.querySelector('#vHome').classList.contains('is-on')&&!document.querySelector('#modelDialog')`), 'chat entry uses normal composer, no legacy dialog');
    assert.equal(sends, 0);
    // Reload renderer and use the saved disk profile, not in-memory input fields.
    await evaluate(`window.__beforeReload = true`);
    await cdp('Page.reload'); await until(`!window.__beforeReload && document.readyState==='complete' && typeof window.mountProviderSettings === 'function'`);
    await evaluate(`if(location.hash==='#models') window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash='models'`);
    await until(`Array.from(document.querySelectorAll('#setBody button')).some(b=>b.textContent==='编辑')`);
    await evaluate(`Array.from(document.querySelectorAll('#setBody button')).find(b=>b.textContent==='＋ 添加模型提供商').click()`);
    await evaluate(`(()=>{const d=document.querySelector('.provider-dialog[open]');d.querySelector('details').open=true;const i=d.querySelectorAll('input');i[0].value='local-fixture-only';i[1].value='http://127.0.0.1:19402/v1';})()`);
    await evaluate(`Array.from(document.querySelectorAll('.provider-dialog[open] button')).find(b=>b.textContent==='获取可用模型').onclick()`);
    assert.equal(gets, 4, 'preset custom URL discovery uses the specified upstream');
    await evaluate(`Array.from(document.querySelectorAll('.provider-dialog[open] button')).find(b=>b.textContent==='创建提供商').onclick()`);
    const duplicate = await evaluate(`(async()=>{const a=personalAgentDesktop,s=(await a.providerSettings('list')).data,p=s.providers.find(p=>p.id==='deepseek');return a.providerSettings('save',{revision:s.revision,provider:{...p,apiKey:'',models:[]}});})()`);
    assert.equal(duplicate.ok, false); assert.match(duplicate.error, /已存在/);
    // Exercise real confirmation, including cancellation, with a focused user gesture.
    let acceptDialog = false, dialogs = 0; const dialogReplies = [];
    ws.onmessage = e => { const m = JSON.parse(e.data); if(m.method==='Page.javascriptDialogOpening') { dialogs++; dialogReplies.push(cdp('Page.handleJavaScriptDialog',{accept:acceptDialog}).then(()=>null,e=>e.message)); } pending.get(m.id)?.(m); };
    await cdp('Page.enable'); await cdp('Page.bringToFront');
    for (const accept of [false, true]) {
      acceptDialog = accept; const before = dialogs;
      const r = await cdp('Runtime.evaluate', { expression: `Array.from(document.querySelectorAll('#setBody button')).find(b=>b.textContent==='删除').onclick()`, userGesture: true, awaitPromise: true, returnByValue: true });
      assert.ok(!r.exceptionDetails, JSON.stringify(r.exceptionDetails));
      assert.equal(dialogs, before + 1, 'delete must actually open confirmation');
      assert.deepEqual(await Promise.all(dialogReplies), Array(dialogReplies.length).fill(null), 'CDP confirmation must succeed');
      const actual = await evaluate(`personalAgentDesktop.providerSettings('list')`);
      const status = await evaluate(`document.querySelector('#setBody [role=status]').textContent`);
      assert.equal(actual.data.providers.length, accept ? 1 : 2, 'delete accept='+accept+'; UI status='+status);
    }
    await until(`(async()=>{const r=await personalAgentDesktop.providerSettings('list');return r.ok&&r.data.providers.length===1;})()`);
    const afterDelete = await evaluate(`personalAgentDesktop.providerSettings('list')`);
    assert.equal(afterDelete.data.providers.length, 1); assert.equal(afterDelete.data.providers[0].id, 'deepseek');
    console.log('PASS real Electron: both discovery tabs, encrypted save, edit/reuse, close/reopen race, reload, duplicate rejection, deletion and selected model send; GET=', gets, 'POST=', sends);
    await evaluate(`document.querySelector('#setClose').click();document.querySelector('#btnNew').click()`);
    await until(`!document.querySelector('#btnNew').disabled && document.querySelector('#taHomeModel').value.includes('deepseek')`);
    async function turn(inputId, buttonId, text, count) {
      await evaluate(`document.getElementById(${JSON.stringify(inputId)}).value=${JSON.stringify(text)};document.getElementById(${JSON.stringify(buttonId)}).click()`);
      await until(`document.querySelectorAll('#liveChatList .msg--agent').length===${count} && !document.querySelector('#btnNew').disabled`);
    }
    await turn('taHome', 'sendHome', 'remember ALPHA', 1);
    assert.ok(await evaluate(`document.querySelector('#liveChatList').textContent.includes('LOCAL SETTINGS MOCK ANSWER')`));
    await turn('taChat', 'sendChat', 'what did I say?', 2);
    assert.deepEqual(prompts.at(-1).filter(m=>m.role==='user').map(m=>m.content), ['remember ALPHA','what did I say?']);
    assert.ok(prompts.at(-1).some(m=>m.role==='assistant' && m.content==='LOCAL SETTINGS MOCK ANSWER'));
    const markdown = '# 标题\n\n**加粗** 和 `行内代码`\n\n```python\nprint("hello")\n<img src=x onerror=alert(1)>\n```\n\n<script>alert(1)</script>\n- 项目';
    assert.ok(await evaluate(`(()=>{const h=document.querySelector('#liveChatList .msg--agent .msg-body>div');window.renderReply(h,${JSON.stringify(markdown)});return h.querySelector('pre code').textContent.includes('<img')&&!h.querySelector('img,script')&&h.querySelector('strong')?.textContent==='加粗'&&h.querySelector('h2')?.textContent==='标题'&&!h.textContent.includes('\u0060\u0060\u0060');})()`), 'safe code blocks and inline formatting');
    const chatShot = await cdp('Page.captureScreenshot', { format: 'png' });
    await fs.writeFile(path.join(artifacts, 'main-chat.png'), Buffer.from(chatShot.data, 'base64'));
    await evaluate(`document.querySelector('#btnNew').click()`);
    await until(`!document.querySelector('#btnNew').disabled && document.querySelector('#liveChatList').children.length===0`);
    await turn('taHome', 'sendHome', 'fresh BETA', 1);
    assert.deepEqual(prompts.at(-1).filter(m=>m.role==='user').map(m=>m.content), ['fresh BETA']);
    failChat = true;
    await turn('taChat', 'sendChat', 'fail once', 2);
    assert.ok(await evaluate(`document.querySelector('#liveChatList').textContent.includes('请求失败')`));
    failChat = false;
    const beforeRetry = sends;
    await turn('taChat', 'sendChat', 'fresh after failure', 1);
    assert.equal(sends, beforeRetry + 1, 'sending after failure starts a new request instead of blocking input');
    assert.deepEqual(prompts.at(-1).filter(m=>m.role==='user').map(m=>m.content), ['fresh after failure'], 'auto-reset sends only the new message, no failed context');
    const sessions = (await fs.readdir(home)).filter(n=>/^desktop-chat-[0-9a-f-]{36}\.jsonl$/.test(n));
    assert.equal(sessions.length, 3, 'failure then send allocates a new persisted conversation');
    assert.equal(dialogs, 2, 'ordinary chat must not open confirmation dialogs');
    const saved = await evaluate(`personalAgentDesktop.listChats()`);
    assert.equal(saved.sessions.length, 3);
    const alpha = saved.sessions.find(s=>s.title==='remember ALPHA'); assert.ok(alpha);
    failChat = false;
    // Seed a persisted workspace association as a restart fixture; native picking is covered by workspace.test.ts.
    const chatIndex = require('../desktop/chat-index.cjs');
    const fixtureRoot = await fs.realpath(home);
    await chatIndex.remember(home, { ...chatIndex.find(home, alpha.id), workspaceRoot: fixtureRoot });
    await evaluate(`window.__beforeReload = true`); await cdp('Page.reload');
    await until(`!window.__beforeReload && document.readyState==='complete' && !!document.querySelector('[data-session="${alpha.id}"]')`);
    await evaluate(`document.querySelector('#setClose').click()`);
    assert.ok(await evaluate(`Array.from(document.querySelectorAll('.session-group summary')).some(n=>n.title===${JSON.stringify(fixtureRoot)})`), 'workspace folder survives reload');
    // Screenshot invariants, asserted structurally so they stay checkable without eyes on the PNG.
    assert.ok(await evaluate(`!document.querySelector('#setScrim').classList.contains('is-on')`), 'no settings overlay left covering the window');
    // Home and chat composers are never visible at once, so each signature is taken while its own view shows.
    const homeComposerControls = await evaluate(`(()=>{const vis=n=>[...n.querySelector('.slot').querySelectorAll('button,select,textarea')].filter(e=>e.offsetParent!==null).map(e=>e.tagName+':'+(e.id||'').replace(/Chat|Home/,''));return vis(document.querySelector('#taHome').closest('.composer'));})()`);
    assert.ok(homeComposerControls.length >= 4, 'home composer must be visible when sampled: ' + JSON.stringify(homeComposerControls));
    assert.ok(await evaluate(`(()=>{const g=[...document.querySelectorAll('.session-group')].find(n=>n.querySelector('summary').title===${JSON.stringify(fixtureRoot)});return g&&g.querySelectorAll('[data-session]').length>0;})()`), 'folder group lists its session row');
    await evaluate(`document.querySelector('[data-session="${alpha.id}"]').click()`);
    await until(`document.querySelector('#liveChatList').textContent.includes('what did I say?')&&!document.querySelector('#sendChat').disabled`);
    assert.ok(await evaluate(`document.querySelector('#liveChatList').textContent.includes('what did I say?')`), 'restored session renders its conversation, not an empty home');
    const composerControls = await evaluate(`(()=>{const vis=n=>[...n.querySelector('.slot').querySelectorAll('button,select,textarea')].filter(e=>e.offsetParent!==null).map(e=>e.tagName+':'+(e.id||'').replace(/Chat|Home/,''));return vis(document.querySelector('#taChat').closest('.composer'));})()`);
    assert.deepEqual(composerControls, homeComposerControls, 'home and chat composers expose the same visible controls: ' + JSON.stringify({chat:composerControls,home:homeComposerControls}));
    assert.ok(await evaluate(`(()=>{const s=document.querySelector('#sendChat').getBoundingClientRect(),m=document.querySelector('#taChatModel').getBoundingClientRect(),t=document.querySelector('#taChat').getBoundingClientRect();return m.right<=s.left+2&&s.top>=t.bottom-2&&s.width>0&&s.height>0;})()`), 'chat composer row is laid out, not clipped');
    const restoredWorkspace = await evaluate(`personalAgentDesktop.workspace('state')`);
    assert.equal(restoredWorkspace.data.root, fixtureRoot); assert.equal(restoredWorkspace.data.permission, 'read');
    assert.ok(await evaluate(`document.querySelector('.workspace-panel').hidden`), 'restoring workspace must not open right panel');
    await turn('taChat','sendChat','resume ALPHA',3);
    const restoredShot = await cdp('Page.captureScreenshot', {format:'png'}); await fs.writeFile(path.join(artifacts,'workspace-chat-restored.png'),Buffer.from(restoredShot.data,'base64'));
    assert.deepEqual(prompts.at(-1).filter(m=>m.role==='user').map(m=>m.content), ['remember ALPHA','what did I say?','resume ALPHA']);
    assert.equal((await evaluate(`personalAgentDesktop.listChats()`)).sessions.length,3);
    console.log('PASS main chat: context, fresh-session isolation, persisted sessions, failure recovery in new session; POST=', sends);
    await require('./ui-wiring-checks.cjs')({evaluate,until,cdp,alphaId:alpha.id});
    // Model tools operate on a separate disposable workspace, never the agent home.
    const toolsRoot = await fs.mkdtemp(path.join(artifacts,'model-workspace-'));
    await fs.writeFile(path.join(toolsRoot,'input.txt'),'WORKSPACE TOOL INPUT');
    await chatIndex.remember(home,{...chatIndex.find(home,alpha.id),workspaceRoot:await fs.realpath(toolsRoot)});
    await evaluate(`document.querySelector('[data-session="${alpha.id}"]').click()`);
    await until(`!document.querySelector('#btnNew').disabled&&document.querySelector('#liveChatList').textContent.includes('resume ALPHA')`);
    async function toolsMode(mode) {
      await evaluate(`window.__modeResult=null;void personalAgentDesktop.workspace('model-tools',{mode:${JSON.stringify(mode)}}).then(r=>window.__modeResult=r)`);
      if(mode!=='off') { await until(`document.querySelector('.confirm-scrim').classList.contains('is-on')`); await evaluate(`document.querySelector('.confirm-yes').click()`); }
      await until(`window.__modeResult!==null`); assert.equal((await evaluate(`window.__modeResult`)).ok,true);
    }
    async function toolSend(text, scenario, answer) {
      toolScenario=scenario;toolStep=0;
      await evaluate(`document.querySelector('#taChat').value=${JSON.stringify(text)};document.querySelector('#sendChat').click()`);
      if(answer!==undefined){await until(`document.querySelector('.confirm-scrim').classList.contains('is-on')`);await evaluate(answer==='stop'?`personalAgentDesktop.stopChat()`:answer?`document.querySelector('.confirm-yes').click()`:`document.querySelector('.confirm-actions button').click()`);}
      await until(`!document.querySelector('#btnNew').disabled`);toolScenario=null;
    }
    await toolsMode('read');
    await toolSend('read file tool acceptance',[{name:'read_file',args:{path:'input.txt'}},{name:'create_file',args:{path:'forbidden.txt',content:'not allowed'}}]);
    assert.ok(await evaluate(`document.querySelector('#liveChatList').textContent.includes('WORKSPACE TOOL INPUT')`));
    await assert.rejects(fs.stat(path.join(toolsRoot,'forbidden.txt')),{code:'ENOENT'});
    await toolsMode('write');
    await toolSend('create approved file',[{name:'create_file',args:{path:'approved.txt',content:'approved text'}}],true);
    assert.equal(await fs.readFile(path.join(toolsRoot,'approved.txt'),'utf8'),'approved text');
    await toolSend('cancel a write',[{name:'edit_file',args:{path:'approved.txt',content:'cancelled text'}}],false);
    assert.equal(await fs.readFile(path.join(toolsRoot,'approved.txt'),'utf8'),'approved text');
    await toolSend('stop pending write',[{name:'edit_file',args:{path:'approved.txt',content:'stopped text'}}],'stop');
    assert.equal(await fs.readFile(path.join(toolsRoot,'approved.txt'),'utf8'),'approved text');
    assert.equal(await evaluate(`document.querySelector('.confirm-scrim').classList.contains('is-on')`),false);
    await evaluate(`document.querySelector('[data-session="${alpha.id}"]').click()`);
    await until(`!document.querySelector('#btnNew').disabled`);
    assert.equal((await evaluate(`personalAgentDesktop.workspace('state')`)).data.modelTools,'off');
    assert.ok(await evaluate(`document.querySelector('#liveChatList').textContent.includes('WORKSPACE TOOL INPUT')`),'history retains actual tool output');
    console.log('PASS model file tools: opt-in, read, forged write denial, approved create, declined edit, stop pending approval, persisted tool results');
    // Click the actual visible button: invoking IPC directly missed the status-node shadowing bug.
    for (const [mode,expected] of [['good','正确的结构化工具调用'],['text','没有返回所声明'],['error','无法判定']]) {
      probeMode=mode; finishProbe=undefined;
      const beforeProbe=probeRequests, sessionCount=(await evaluate(`personalAgentDesktop.listChats()`)).sessions.length;
      const point=await evaluate(`(()=>{const b=document.querySelector('#taChat').closest('.composer').querySelector('[data-action="test-tools"]');const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
      await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
      await until(`document.querySelector('#taChat').closest('.composer').querySelector('.composer-status').textContent.includes('正在检测工具协议')`);
      assert.ok(await evaluate(`Array.from(document.querySelectorAll('[data-action="test-tools"]')).every(b=>b.disabled&&b.textContent==='检测中…')`));
      for(let i=0;i<100&&!finishProbe;i++)await new Promise(r=>setTimeout(r,50));
      assert.equal(probeRequests,beforeProbe+1,'one real click sends exactly one diagnostic request');
      assert.ok(finishProbe); finishProbe();
      await until(`document.querySelector('#taChat').closest('.composer').querySelector('.composer-status').textContent.includes(${JSON.stringify(expected)})&&!document.querySelector('[data-action="test-tools"]').disabled`);
      assert.equal(await evaluate(`!!document.querySelector('.composer-status script')`),false);
      assert.equal((await evaluate(`personalAgentDesktop.listChats()`)).sessions.length,sessionCount,'probe does not create conversation or execute tools');
      probeMode=null;
    }
    console.log('PASS actual 检测工具 click: pending feedback, single IPC/HTTP, structured success, text-only mismatch, request failure and re-enabled controls');
    console.log('Screenshots:', path.join(artifacts, 'provider-settings.png'), path.join(artifacts, 'main-chat.png'));
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
