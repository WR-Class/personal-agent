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
  let gets = 0, sends = 0, ws, child, finishStream, streamClosed=false;
  const prompts = [], sentModels = []; let failChat = false, toolScenario = null, toolStep = 0, toolHoldFinal = false, toolHeld = 0, slowChat = false, slowSeen = 0, slowClosed = 0;
  const server = http.createServer(async (req, res) => {
    assert.equal(req.headers.authorization, 'Bearer local-fixture-only');
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/v1/models' && req.method === 'GET') { gets++; res.end(JSON.stringify({ data: [{ id: 'fixture-model' }, { id: 'fixture-other' }] })); return; }
    assert.equal(req.url, '/v1/chat/completions');
    let body = ''; for await (const c of req) body += c;
    const p = JSON.parse(body); assert.equal(p.max_tokens,64000); assert.ok(['fixture-model','fixture-other'].includes(p.model)); sentModels.push(p.model); sends++;
    if(process.env.PA_VERIFY_STREAM==='1'){
      assert.equal(p.stream,true);res.setHeader('Content-Type','text/event-stream');
      const frame=(delta,finish_reason=null)=>'data: '+JSON.stringify({choices:[{index:0,delta,finish_reason}]})+'\n\n';
      if(sends===5){res.writeHead(503);res.end('{}');return;}
      if(sends===3){res.write(frame({reasoning_content:'先检查目标',content:'我先检查目标。',tool_calls:[{index:0,id:'goal-preview',type:'function',function:{name:'get_goal',arguments:'{}'}}]}));finishStream=()=>res.end(frame({},'tool_calls')+'data: [DONE]\n\n');return;}
      res.write(frame({reasoning_content:'private-reasoning',content:'鹈鹕🚲 <svg onload="window.streamXss=1">实时预览</svg>'}));
      res.on('close',()=>{streamClosed=true;});finishStream=()=>res.end(frame({content:' · 完整结束'})+frame({},'stop')+'data: [DONE]\n\n');return;
    }
    if (slowChat) { slowSeen++; res.once('close',()=>{slowClosed++;}); return; }
    if (toolScenario) {
      assert.ok(p.tools.some(t=>t.function.name==='read_file'));
      if (toolScenario.some(c=>c.name==='run_command')) assert.ok(p.tools.some(t=>t.function.name==='run_command'),'model command is in the core catalog');
      const call = toolScenario[toolStep++];
      if (!call && toolHoldFinal) { toolHeld++; return; }
      const message = call ? {role:'assistant',content:null,tool_calls:[{id:'tool-'+toolStep,type:'function',function:{name:call.name,arguments:JSON.stringify(call.args)}}]} : {role:'assistant',content:'MODEL FILE TOOLS DONE'};
      res.end(JSON.stringify({model:'fixture-model',choices:[{message,finish_reason:call?'tool_calls':'stop'}]})); return;
    }
    if (process.env.PA_VERIFY_OUTPUT_BUDGET === '1') {
      assert.ok(p.tools?.some(t=>t.function.name==='get_goal'),'host task tools present without workspace');
    }
    else if (p.tools?.some(t=>t.function.name==='read_file')) {
      const names=p.tools.map(t=>t.function.name);
      for(const name of ['read_file','inspect_file','list_directory','job_output']) assert.ok(names.includes(name),'shared read catalog includes '+name);
    }
    else assert.ok(!p.tools?.length||p.tools.some(t=>t.function.name==='get_goal'),'host-only tools allowed without workspace');
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
    assert.equal((await evaluate(`personalAgentDesktop.workspace('state')`)).data.permission, 'write');
    assert.equal(await evaluate(`!!document.querySelector('#btnStop,#btnStopHome,[data-action="test-tools"],.model-tools-select')`),false,'removed separate stop/probe/tool-mode controls');
    assert.equal(Object.hasOwn((await evaluate(`personalAgentDesktop.workspace('state')`)).data,'modelTools'),false);
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.workspace-controls select')).map(s=>Array.from(s.options).map(o=>o.value))`),[['read','write','full'],['read','write','full']]);
    assert.equal((await evaluate(`personalAgentDesktop.workspace('terminal',{command:'echo forbidden'})`)).ok, false);
    assert.equal((await evaluate(`personalAgentDesktop.workspace('browser-open',{url:'file:///C:/Windows/win.ini'})`)).ok, false);
    await evaluate(`document.querySelector('#workspaceToggle').click()`);
    await until(`!document.querySelector('.workspace-panel').hidden`);
    const toolShot = await cdp('Page.captureScreenshot', {format:'png'}); await fs.writeFile(path.join(artifacts,'workspace-panel.png'),Buffer.from(toolShot.data,'base64'));
    await evaluate(`document.querySelector('#workspaceToggle').click()`);
    assert.ok(await evaluate(`(()=>{const s=document.querySelector('#sendHome').getBoundingClientRect(),m=document.querySelector('#vHome .agent-picker[data-kind="model"]').getBoundingClientRect(),w=document.querySelector('.workspace-controls').getBoundingClientRect();return m.right<=s.left+2&&w.top>=s.bottom;})()`),'model before send and workspace below composer');
    const nativeViewport = await evaluate(`({width:innerWidth,height:innerHeight})`);
    async function assertNativeViewport() {
      await until(`innerWidth===${nativeViewport.width}&&innerHeight===${nativeViewport.height}&&Math.abs(document.querySelector('.statusbar').getBoundingClientRect().bottom-innerHeight)<=1`);
    }
    async function checkProviderLayout(width, tag) {
      try {
        await cdp('Emulation.setDeviceMetricsOverride', { width, height: 800, deviceScaleFactor: 1, mobile: false });
        assert.ok(await evaluate(`(()=>{const d=document.querySelector('.provider-dialog[open]'),r=d.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight&&d.scrollWidth<=d.clientWidth+1&&Array.from(d.querySelectorAll('button')).every(b=>{const s=getComputedStyle(b);return b.clientHeight>=parseFloat(s.paddingTop)+parseFloat(s.paddingBottom)+parseFloat(s.lineHeight)});})()`), 'dialog and buttons fit '+width);
        const image = await cdp('Page.captureScreenshot', { format: 'png' });
        await fs.writeFile(path.join(artifacts, tag+'-'+width+'.png'), Buffer.from(image.data,'base64'));
      } finally {
        // Viewport emulation is not a window resize: leaving height=800 shrinks a 900px window's page.
        await cdp('Emulation.clearDeviceMetricsOverride');
        await assertNativeViewport();
      }
      console.log(`PASS viewport restored after ${tag}-${width}: emulated height=800 -> native ${nativeViewport.width}x${nativeViewport.height}, statusbar at bottom`);
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
    assert.equal(await evaluate(`document.querySelector('[data-output-model="fixture-model"]').placeholder`),'默认 64000');
    await evaluate(`document.querySelector('[data-thinking-model="fixture-model"]').click()`);
    await evaluate(`(()=>{const b=document.querySelector('[data-output-model="fixture-model"]');b.value='16384';b.dispatchEvent(new Event('input'));})()`);
    await checkProviderLayout(520,'provider-output');
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
    assert.equal(await evaluate(`document.querySelector('[data-output-model="fixture-model"]').value`),'16384');
    assert.equal(await evaluate(`document.querySelector('[data-thinking-model="fixture-model"]').checked`),true);await evaluate(`document.querySelector('[data-thinking-model="fixture-model"]').click()`);
    await evaluate(`(()=>{const b=document.querySelector('[data-output-model="fixture-model"]');b.value='';b.dispatchEvent(new Event('input'));})()`);
    await evaluate(`Array.from(document.querySelectorAll('.provider-dialog button')).find(b=>b.textContent==='获取可用模型').onclick()`);
    assert.equal(gets, 2, 'saved encrypted key reused only at original endpoint');
    // Start save, close A and open B in the same JS task. A must refresh state but never close B.
    assert.equal(await evaluate(`(async()=>{const a=document.querySelector('.provider-dialog');const done=Array.from(a.querySelectorAll('button')).find(b=>b.textContent==='保存').onclick();a.close();Array.from(document.querySelectorAll('#setBody button')).find(b=>b.textContent==='＋ 添加模型提供商').click();const b=document.querySelector('.provider-dialog[open]');await done;const alive=b.open;b.close();return alive;})()`), true);
    await evaluate(`Array.from(document.querySelectorAll('#setBody button')).find(b=>b.textContent==='编辑').click()`);
    await evaluate(`Array.from(document.querySelectorAll('.provider-dialog[open] button')).find(b=>b.textContent==='获取可用模型').onclick()`);
    assert.equal(gets, 3, 'close-during-save still refreshes revision');
    assert.equal(await evaluate(`document.querySelector('[data-output-model="fixture-model"]').value`),'');
    assert.equal(await evaluate(`document.querySelector('[data-thinking-model="fixture-model"]').checked`),false);
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
      await until(`Array.from(document.querySelectorAll('#setBody button')).some(b=>b.textContent==='删除')`);
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
    if(process.env.PA_VERIFY_STREAM==='1'){
      await evaluate(`document.querySelector('#taHome').value='生成SVG';document.querySelector('#sendHome').click()`);
      try{await until(`document.querySelector('#liveChatList').textContent.includes('实时预览')`);}catch(e){console.log('STREAM DEBUG',sends,await evaluate(`({text:document.querySelector('#liveChatList').textContent,streamApi:typeof personalAgentDesktop.onChatStream})`));throw e;}
      assert.equal(await evaluate(`document.querySelector('#btnNew').disabled`),true,'preview arrives before completion');
      await until(`document.body.textContent.includes('思考 17')&&document.body.textContent.includes('距上次数据')`);
      assert.equal(await evaluate(`document.querySelector('.provider-reasoning').textContent.includes('private-reasoning')`),true,'provider reasoning streams into expandable panel');
      assert.equal(await evaluate(`document.querySelector('.live-process').open`),true);
      assert.equal(await evaluate(`!!window.streamXss||!!document.querySelector('#liveChatList .message-content svg')`),false,'HTML preview remains inert text');
      const image=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(artifacts,'desktop-streaming.png'),Buffer.from(image.data,'base64'));
      finishStream();await until(`!document.querySelector('#btnNew').disabled&&document.querySelector('#liveChatList').textContent.includes('完整结束')`);
      assert.equal(await evaluate(`document.querySelectorAll('#liveChatList .msg--agent').length`),1,'final replaces preview without duplication');
      assert.equal(await evaluate(`document.querySelector('.live-process').open`),false,'process auto-collapses after final result');
      streamClosed=false;await evaluate(`document.querySelector('#taChat').value='再来';document.querySelector('#sendChat').click()`);
      await until(`document.querySelectorAll('#liveChatList .msg--agent')[1]?.textContent.includes('实时预览')`);
      await evaluate(`document.querySelector('#sendChat').click()`);await until(`!document.querySelector('#btnNew').disabled`);
      assert.ok(streamClosed,'stop closes upstream socket');assert.ok(await evaluate(`document.querySelector('#liveChatList').textContent.includes('未完成预览')`));assert.equal(sends,2);assert.equal(await evaluate(`document.querySelectorAll('.live-process[open]').length`),0,'cancel collapses all process panels');
      await evaluate(`document.querySelector('#taChat').value='检查目标';document.querySelector('#sendChat').click()`);await until(`document.body.textContent.includes('查看目标 · 接收参数 2 字符，尚未执行')`);
      assert.equal(sends,3,'no tool roundtrip before stream completion');finishStream();await until(`document.body.textContent.includes('查看目标 · 已完成')`);assert.equal(sends,4);
      await until(`document.querySelectorAll('.provider-reasoning').length>=4`);
      assert.equal(await evaluate(`document.querySelectorAll('.live-process[data-state="complete"]').length`),2,'prior thinking already terminal before next response ends');
      finishStream();await until(`!document.querySelector('#btnNew').disabled`);
      assert.ok(await evaluate(`document.querySelector('#liveChatList').textContent.includes('我先检查目标。')`),'prior step commentary retained');assert.equal(await evaluate(`document.querySelectorAll('.live-process[open]').length`),0);
      assert.equal(await evaluate(`document.querySelectorAll('.tool-card[data-call-id="goal-preview"]').length`),1,'tool evidence updates original row without duplicate pile');
      await evaluate(`document.querySelector('#taChat').value='测试重试';document.querySelector('#sendChat').click()`);await until(`document.querySelector('.retry-note')?.textContent.includes('重试 1/2')`);await until(`document.querySelectorAll('.provider-reasoning').length>=5`);assert.equal(sends,6);finishStream();await until(`!document.querySelector('#btnNew').disabled`);
      const timeline=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(artifacts,'desktop-timeline.png'),Buffer.from(timeline.data,'base64'));
      console.log('PASS real Electron reasoning/text/tool preview, validated tool execution, multi-step retention, collapse and stop');return;
    }
    await turn('taHome', 'sendHome', 'remember ALPHA', 1);
    assert.ok(await evaluate(`document.querySelector('#liveChatList').textContent.includes('LOCAL SETTINGS MOCK ANSWER')`));
    if(process.env.PA_VERIFY_OUTPUT_BUDGET==='1'){assert.equal(sends,1);console.log('PASS output budget UI: default, override save/reopen, clear/reopen and actual 64000 request; legacy tool scenarios not run');return;}
    if(process.env.PA_VERIFY_DELIVERY==='1'){
      const index=require('../desktop/chat-index.cjs'),r=await evaluate(`personalAgentDesktop.listChats()`),id=r.sessions[0].id,root=await fs.mkdtemp(path.join(artifacts,'delivery-workspace-'));
      await index.remember(home,{...index.find(home,id),workspaceRoot:await fs.realpath(root)});
      await cdp('Page.reload');await until(`!!document.querySelector('[data-session="${id}"]')&&!document.querySelector('#btnNew').disabled`);await evaluate(`document.querySelector('[data-session="${id}"]').click()`);await until(`(async()=>{const s=await personalAgentDesktop.workspace('state');return s.data.root===${JSON.stringify(await fs.realpath(root))};})()`);
      await until(`!document.querySelector('#btnNew').disabled&&document.querySelector('#liveChatList').textContent.includes('LOCAL SETTINGS MOCK ANSWER')`);
      await verifyDelivery(root);console.log('PASS delivery: themed table, inert HTML, clickable HTML isolated preview and Markdown preview');return;
    }
    async function checkChatLayout() {
      const geometry = await evaluate(`(()=>{const l=document.querySelector('#liveChatList'),u=l.querySelector('.msg--user .msg-body'),a=l.querySelector('.msg--agent .msg-body'),r=l.getBoundingClientRect(),us=u.getBoundingClientRect(),as=a.getBoundingClientRect(),padding=parseFloat(getComputedStyle(l).paddingLeft);return {userRight:us.right,assistantLeft:as.left,left:r.left+padding,right:r.right-padding,userLeft:us.left,assistantRight:as.right,labels:[...l.querySelectorAll('.msg')].map(n=>n.getAttribute('aria-label')),visibleRoleTags:[...l.querySelectorAll('.msg-body>strong,.msg-name')].filter(n=>n.getClientRects().length).length};})()`);
      assert.ok(Math.abs(geometry.userRight-geometry.right)<2,'user right-aligned: '+JSON.stringify(geometry));
      assert.ok(Math.abs(geometry.assistantLeft-geometry.left)<2,'assistant left-aligned: '+JSON.stringify(geometry));
      assert.ok(geometry.userLeft>geometry.left+20 && geometry.assistantRight<geometry.right-20,'short messages occupy opposite sides');
      assert.equal(geometry.visibleRoleTags,0); assert.ok(geometry.labels.includes('你')&&geometry.labels.includes('Personal Agent'));
    }
    await checkChatLayout();
    assert.equal(await evaluate(`document.querySelector('#sbTokens')!==null`),false,'footer usage placeholder removed');
    assert.match(await evaluate(`document.querySelector('.composer-usage [data-metric=tokens]').textContent`),/^— tok/,'provider fixture omits usage: unknown, not made-up zero');
    assert.ok(await evaluate(`!!document.querySelector('#chatScroll>.composer-status')&&!document.querySelector('#vChat .composer .composer-status')`),'operational status remains visible separately from usage');
    // Switch after first success: cancel and token invalidation cannot mutate host identity/history.
    const activeBefore = await evaluate(`personalAgentDesktop.listChats()`);
    const activeId = activeBefore.activeSessionId;
    const historyBefore = await fs.readFile(path.join(home, activeId+'.jsonl'), 'utf8');
    const indexBefore = await fs.readFile(path.join(home, 'desktop-chat-index.json'), 'utf8');
    const oldValue = await evaluate(`document.querySelector('#taChatModel').value`);
    const newValue = JSON.stringify({id:'deepseek',model:'fixture-other'});
    async function selectModel(value) {
      await evaluate(`(()=>{const s=document.querySelector('#taChatModel');s.value=${JSON.stringify(value)};void s.onchange();})()`);
      await until(`document.querySelector('.confirm-scrim').classList.contains('is-on')`);
    }
    assert.equal(await evaluate(`document.querySelector('#taChatModel').disabled`), false);
    await evaluate(`document.querySelector('#vChat .agent-picker[data-kind="model"]').focus()`);
    for (const key of ['ArrowDown','ArrowDown','Enter']) {
      const code = key === 'Enter' ? 13 : 40;
      await cdp('Input.dispatchKeyEvent', {type:'keyDown',key,code:key,windowsVirtualKeyCode:code});
      await cdp('Input.dispatchKeyEvent', {type:'keyUp',key,code:key,windowsVirtualKeyCode:code});
    }
    await until(`document.querySelector('.confirm-scrim').classList.contains('is-on')`);
    assert.equal(await evaluate(`document.querySelector('#taChatModel').disabled`), true);
    assert.equal(await evaluate(`document.querySelector('#sendChat').disabled`),true,'unrelated model-switch busy cannot send or stop');
    assert.equal(await evaluate(`personalAgentDesktop.resetChat().then(()=>false,()=>true)`), true);
    assert.equal(await evaluate(`personalAgentDesktop.switchChatModel(0).then(()=>false,()=>true)`), true);
    await evaluate(`document.querySelector('.confirm-actions button').click()`);
    await until(`!document.querySelector('#btnNew').disabled`);
    assert.equal(await evaluate(`document.querySelector('#taChatModel').value`), oldValue);
    assert.equal(await fs.readFile(path.join(home,'desktop-chat-index.json'),'utf8'), indexBefore);
    await selectModel(newValue);
    await evaluate(`personalAgentDesktop.getProvider(${newValue})`); // supersedes the pending token
    await evaluate(`document.querySelector('.confirm-yes').click()`);
    await until(`!document.querySelector('#btnNew').disabled`);
    assert.equal(await evaluate(`document.querySelector('#taChatModel').value`), oldValue);
    assert.equal(await fs.readFile(path.join(home,'desktop-chat-index.json'),'utf8'), indexBefore);
    await selectModel(newValue);
    await evaluate(`document.querySelector('.confirm-yes').click()`);
    await until(`!document.querySelector('#btnNew').disabled`);
    assert.equal(await evaluate(`document.querySelector('#taChatModel').value`), newValue);
    const switched = await evaluate(`personalAgentDesktop.listChats()`);
    assert.equal(switched.activeSessionId, activeId); assert.equal(switched.sessions.length, activeBefore.sessions.length);
    assert.equal(await fs.readFile(path.join(home,activeId+'.jsonl'),'utf8'), historyBefore);
    assert.equal(JSON.parse(JSON.parse(await fs.readFile(path.join(home,'desktop-chat-index.json'),'utf8')).sessions.find(s=>s.id===activeId).identity)[2], 'fixture-other');
    assert.equal((await evaluate(`personalAgentDesktop.workspace('state')`)).data.permission,'read');
    await turn('taChat', 'sendChat', 'what did I say?', 2);
    assert.equal(sentModels.at(-1),'fixture-other');
    const reopened = await evaluate(`personalAgentDesktop.openChat(${JSON.stringify(activeId)})`);
    assert.equal(reopened.canResume,true); assert.equal(reopened.selection.model,'fixture-other');
    console.log('PASS model switch: host consent, cancel, stale token, busy guard, same session/history, new outgoing model, persistent reopen');
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
    const failedChat = await evaluate(`personalAgentDesktop.listChats()`);
    await turn('taChat','sendChat','direct continuation',3);
    assert.equal((await evaluate(`personalAgentDesktop.listChats()`)).activeSessionId,failedChat.activeSessionId);
    assert.equal((await evaluate(`personalAgentDesktop.listChats()`)).sessions.length,2);
    failChat=true; await turn('taChat','sendChat','fail again',4); failChat=false;
    await evaluate(`document.querySelector('[data-session="${failedChat.activeSessionId}"]').click()`);
    await until(`!document.querySelector('#btnNew').disabled`);
    await turn('taChat', 'sendChat', 'continue after failure', 3);
    assert.equal(sends, beforeRetry + 3, 'only the explicit send requests the model');
    assert.deepEqual(prompts.at(-1).filter(m=>m.role==='user').map(m=>m.content), ['fresh BETA','fail once','direct continuation','fail again','continue after failure']);
    assert.equal((await evaluate(`personalAgentDesktop.listChats()`)).activeSessionId,failedChat.activeSessionId);
    assert.equal((await evaluate(`personalAgentDesktop.listChats()`)).sessions.length,2,'failure/reopen/continue keeps two sidebar IDs');
    // Keep one failed fixture for search/filter checks, but create it ONLY by explicit New.
    await evaluate(`document.querySelector('#btnNew').click()`); await until(`!document.querySelector('#btnNew').disabled`);
    failChat=true; await turn('taHome','sendHome','fresh BETA',1); failChat=false;
    const sessions = (await fs.readdir(home)).filter(n=>/^desktop-chat-[0-9a-f-]{36}\.jsonl$/.test(n));
    assert.equal(sessions.length, 3, 'only explicit New allocates the third persisted conversation');
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
    await until(`!document.querySelector('#btnNew').disabled&&document.querySelector('#vChat').classList.contains('is-on')`);
    assert.equal((await evaluate(`personalAgentDesktop.listChats()`)).sessions.length,3,'reload preserves active chat without allocating');
    await evaluate(`document.querySelector('#setClose').click()`);
    await until(`!document.querySelector('#setScrim').classList.contains('is-on')`);
    await evaluate(`document.querySelector('#btnNew').click()`);
    await until(`!document.querySelector('#btnNew').disabled`);
    assert.ok(await evaluate(`Array.from(document.querySelectorAll('.session-group summary')).some(n=>n.title===${JSON.stringify(fixtureRoot)})`), 'workspace folder survives reload');
    // Screenshot invariants, asserted structurally so they stay checkable without eyes on the PNG.
    assert.ok(await evaluate(`!document.querySelector('#setScrim').classList.contains('is-on')`), 'no settings overlay left covering the window');
    // Home and chat composers are never visible at once, so each signature is taken while its own view shows.
    const homeComposerControls = await evaluate(`(()=>{const vis=n=>[...n.querySelector('.slot').querySelectorAll('button,select,textarea')].filter(e=>e.offsetParent!==null).map(e=>e.tagName+':'+(e.dataset.kind || e.id || '').replace(/Chat|Home/,''));return vis(document.querySelector('#taHome').closest('.composer'));})()`);
    assert.ok(homeComposerControls.length >= 4, 'home composer must be visible when sampled: ' + JSON.stringify(homeComposerControls));
    assert.ok(await evaluate(`(()=>{const g=[...document.querySelectorAll('.session-group')].find(n=>n.querySelector('summary').title===${JSON.stringify(fixtureRoot)});return g&&g.querySelectorAll('[data-session]').length>0;})()`), 'folder group lists its session row');
    await evaluate(`document.querySelector('[data-session="${alpha.id}"]').click()`);
    await until(`document.querySelector('#liveChatList').textContent.includes('what did I say?')&&!document.querySelector('#sendChat').disabled`);
    assert.ok(await evaluate(`document.querySelector('#liveChatList').textContent.includes('what did I say?')`), 'restored session renders its conversation, not an empty home');
    const composerControls = await evaluate(`(()=>{const vis=n=>[...n.querySelector('.slot').querySelectorAll('button,select,textarea')].filter(e=>e.offsetParent!==null).map(e=>e.tagName+':'+(e.dataset.kind || e.id || '').replace(/Chat|Home/,''));return vis(document.querySelector('#taChat').closest('.composer'));})()`);
    for (const control of ['BUTTON:model','BUTTON:permission','BUTTON:send','TEXTAREA:ta']) {
      assert.ok(homeComposerControls.includes(control) && composerControls.includes(control), 'shared composer control: ' + control);
    }
    assert.ok(await evaluate(`document.querySelector('#vChat .workspace-choose').offsetParent===null&&document.querySelector('#vChat .slot-bar .agent-picker[data-kind=permission]').offsetParent!==null`), 'chat hides folder selector and puts permissions beside plus');
    assert.ok(await evaluate(`(()=>{const s=document.querySelector('#sendChat').getBoundingClientRect(),m=document.querySelector('#vChat .agent-picker[data-kind=model]').getBoundingClientRect(),t=document.querySelector('#taChat').getBoundingClientRect();return m.right<=s.left+2&&s.top>=t.bottom-2&&s.width>0&&s.height>0;})()`), 'chat composer row is laid out, not clipped');
    const restoredWorkspace = await evaluate(`personalAgentDesktop.workspace('state')`);
    assert.equal(restoredWorkspace.data.root, fixtureRoot); assert.equal(restoredWorkspace.data.permission, 'read');
    assert.ok(await evaluate(`document.querySelector('.workspace-panel').hidden`), 'restoring workspace must not open right panel');
    async function verifyDelivery(fixtureRoot){
    await evaluate(`document.querySelector('#setClose').click()`);await until(`!document.querySelector('#setScrim').classList.contains('is-on')`);
    await fs.writeFile(path.join(fixtureRoot,'delivery-demo.html'),'<h1>动画预览</h1><script>document.body.dataset.ran="yes";fetch("https://example.com/leak").catch(()=>{});</script>');
    await fs.writeFile(path.join(fixtureRoot,'delivery-demo.md'),'## 文章预览\n\n| 项目 | 结果 |\n| --- | --- |\n| 文件 | **完成** |');
    await evaluate(`(()=>{const host=document.createElement('div');host.id='deliveryFixture';document.querySelector('#liveChatList').append(host);renderReply(host,${JSON.stringify('## 交付清单\n\n| 文件 | 状态 |\n| --- | --- |\n| `delivery-demo.html` | **已生成** |\n\n[文章](delivery-demo.md)\n\n<script>window.deliveryXss=1</script>')});})()`);
    assert.equal(await evaluate(`document.querySelectorAll('#deliveryFixture table td').length`),2);assert.equal(await evaluate(`!!window.deliveryXss`),false);
    await evaluate(`document.querySelector('#deliveryFixture .deliverable-link').click()`);await until(`document.querySelector('.workspace-panel').textContent.includes('隔离预览')`);
    const previewTargets=await(await fetch('http://127.0.0.1:9224/json/list')).json(),previewTarget=previewTargets.find(t=>t.url.startsWith('data:text/html'));assert.ok(previewTarget,'HTML uses isolated data document');
    const previewSocket=new WebSocket(previewTarget.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{previewSocket.onopen=resolve;previewSocket.onerror=reject;});
    const isolated=await new Promise(resolve=>{previewSocket.onmessage=e=>resolve(JSON.parse(e.data));previewSocket.send(JSON.stringify({id:1,method:'Runtime.evaluate',params:{expression:'new Promise(resolve=>{const done=()=>resolve({ran:document.body?.dataset.ran,node:typeof require,ipc:typeof personalAgentDesktop,csp:document.querySelector("meta")?.content});if(document.readyState==="complete")done();else window.addEventListener("load",done,{once:true});})',awaitPromise:true,returnByValue:true}}));});previewSocket.close();
    assert.equal(isolated.result.result.value.ran,'yes');assert.equal(isolated.result.result.value.node,'undefined');assert.equal(isolated.result.result.value.ipc,'undefined');assert.ok(isolated.result.result.value.csp.includes("connect-src 'none'"));
    const htmlShot=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(artifacts,'desktop-html-delivery.png'),Buffer.from(htmlShot.data,'base64'));
    await evaluate(`document.querySelectorAll('#deliveryFixture .deliverable-link')[1].click()`);await until(`document.querySelector('.workspace-content table')?.textContent.includes('完成')`);
    const deliveryShot=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(artifacts,'desktop-delivery.png'),Buffer.from(deliveryShot.data,'base64'));
    await evaluate(`document.querySelector('.workspace-panel header button:last-child').click();document.querySelector('#deliveryFixture').remove()`);
    }
    await verifyDelivery(fixtureRoot);
    await turn('taChat','sendChat','resume ALPHA',3);
    const restoredShot = await cdp('Page.captureScreenshot', {format:'png'}); await fs.writeFile(path.join(artifacts,'workspace-chat-restored.png'),Buffer.from(restoredShot.data,'base64'));
    assert.deepEqual(prompts.at(-1).filter(m=>m.role==='user').map(m=>m.content), ['remember ALPHA','what did I say?','resume ALPHA']);
    assert.equal((await evaluate(`personalAgentDesktop.listChats()`)).sessions.length,3);
    console.log('PASS main chat: context, fresh-session isolation, persisted sessions, failure/reopen/continuation in same session; POST=', sends);
    await require('./ui-wiring-checks.cjs')({evaluate,until,cdp,alphaId:alpha.id});
    // Model tools operate on a separate disposable workspace, never the agent home.
    const toolsRoot = await fs.mkdtemp(path.join(artifacts,'model-workspace-'));
    await fs.writeFile(path.join(toolsRoot,'input.txt'),'WORKSPACE TOOL INPUT');
    await chatIndex.remember(home,{...chatIndex.find(home,alpha.id),workspaceRoot:await fs.realpath(toolsRoot)});
    await evaluate(`document.querySelector('[data-session="${alpha.id}"]').click()`);
    await until(`!document.querySelector('#btnNew').disabled&&document.querySelector('#liveChatList').textContent.includes('resume ALPHA')`);
    async function permission(mode) {
      await evaluate(`(()=>{const s=document.querySelector('#taChat').closest('.composer').querySelector('.workspace-controls select');s.value=${JSON.stringify(mode)};s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
      if(mode==='full') { await until(`document.querySelector('.confirm-scrim').classList.contains('is-on')`); await evaluate(`document.querySelector('.confirm-yes').click()`); }
      await until(`(async()=>{const s=await personalAgentDesktop.workspace('state');return s.ok&&s.data.permission===${JSON.stringify(mode)};})()`);
      assert.ok(await evaluate(`Array.from(document.querySelectorAll('.workspace-controls select')).every(s=>s.value===${JSON.stringify(mode)})`),'permission syncs both composers');
    }
    async function toolSend(text, scenario, answer) {
      toolScenario=scenario;toolStep=0;
      await evaluate(`document.querySelector('#taChat').value=${JSON.stringify(text)};document.querySelector('#sendChat').click()`);
      if(answer!==undefined){
        await until(`document.querySelector('.confirm-scrim').classList.contains('is-on')`);
        await assertNativeViewport();
        if (text === 'decline a command') {
          const shot = await cdp('Page.captureScreenshot', {format:'png'});
          await fs.writeFile(path.join(artifacts,'command-confirm-native-viewport.png'),Buffer.from(shot.data,'base64'));
        }
        if(answer==='stop') {
          await cdp('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
          await cdp('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
        } else await evaluate(answer?`document.querySelector('.confirm-yes').click()`:`document.querySelector('.confirm-actions button').click()`);
      }
      await until(`!document.querySelector('#btnNew').disabled`);toolScenario=null;
      await assertNativeViewport();
    }
    assert.equal((await evaluate(`personalAgentDesktop.workspace('state')`)).data.permission,'read');
    assert.equal(await evaluate(`document.querySelector('.confirm-scrim').classList.contains('is-on')`),false,'read tools need no extra opt-in after choosing workspace');
    await toolSend('read file tool acceptance',[{name:'read_file',args:{path:'input.txt'}},{name:'create_file',args:{path:'forbidden.txt',content:'not allowed'}}]);
    assert.ok(await evaluate(`document.querySelector('#liveChatList').textContent.includes('WORKSPACE TOOL INPUT')`));
    assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('#liveChatList .tool-card')).map(d=>({open:d.open,state:d.dataset.state,kinds:[...d.querySelectorAll('.tool-evidence')].map(n=>n.dataset.kind)}))`),[
      {open:false,state:'success',kinds:['call','result']},{open:false,state:'error',kinds:['call','result']}
    ],'two calls produce two collapsed cards, not four separate messages');
    assert.ok(await evaluate(`(()=>{const d=document.querySelector('#liveChatList .tool-card');d.querySelector('summary').click();return d.open&&d.textContent.includes('input.txt')&&d.textContent.includes('WORKSPACE TOOL INPUT');})()`),'expansion retains arguments and actual output');
    await assert.rejects(fs.stat(path.join(toolsRoot,'forbidden.txt')),{code:'ENOENT'});
    await permission('write');
    await toolSend('create workspace file without prompt',[{name:'create_file',args:{path:'approved.txt',content:'approved text'}}]);
    assert.equal(await fs.readFile(path.join(toolsRoot,'approved.txt'),'utf8'),'approved text');
    assert.equal(await evaluate(`document.querySelector('.confirm-scrim').classList.contains('is-on')`),false);
    await toolSend('run approved core command',[{name:'run_command',args:{command:'echo CORE COMMAND APPROVED'}}],true);
    assert.ok(await evaluate(`document.querySelector('#liveChatList').textContent.includes('CORE COMMAND APPROVED')`));
    await toolSend('decline a command',[{name:'run_command',args:{command:'echo denied > denied-command.txt'}}],false);
    await assert.rejects(fs.stat(path.join(toolsRoot,'denied-command.txt')),{code:'ENOENT'});
    await toolSend('stop pending command',[{name:'run_command',args:{command:'echo stopped > stopped-command.txt'}}],'stop');
    assert.equal(toolStep,1,'Escape aborts the whole turn, not only approval before another model request');
    await assert.rejects(fs.stat(path.join(toolsRoot,'stopped-command.txt')),{code:'ENOENT'});
    assert.equal(await fs.readFile(path.join(toolsRoot,'approved.txt'),'utf8'),'approved text');
    assert.equal(await evaluate(`document.querySelector('.confirm-scrim').classList.contains('is-on')`),false);
    await evaluate(`document.querySelector('[data-session="${alpha.id}"]').click()`);
    await until(`!document.querySelector('#btnNew').disabled`);
    assert.equal((await evaluate(`personalAgentDesktop.workspace('state')`)).data.permission,'read');
    assert.ok(await evaluate(`document.querySelector('#liveChatList').textContent.includes('WORKSPACE TOOL INPUT')`),'history retains actual tool output');
    const restoredCards=await evaluate(`Array.from(document.querySelectorAll('#liveChatList .tool-card')).map(d=>({open:d.open,state:d.dataset.state,call:d.querySelector('[data-kind=call] pre')?.textContent,result:d.querySelector('[data-kind=result] pre')?.textContent}))`);
    assert.equal(restoredCards.length,6,'repeated call IDs across turns never overwrite earlier cards');
    assert.ok(restoredCards.every(d=>!d.open&&d.call!==undefined&&d.result!==undefined),'history pairs complete evidence and defaults collapsed');
    assert.equal(restoredCards.filter(d=>d.state==='error').length,3,'forged write, declined command and stopped command retain failure status');
    await checkChatLayout();
    const beforeContinue=(await evaluate(`personalAgentDesktop.listChats()`));
    await turn('taChat','sendChat','continue after stop',await evaluate(`document.querySelectorAll('#liveChatList .msg--agent').length`)+1);
    assert.equal((await evaluate(`personalAgentDesktop.listChats()`)).activeSessionId,alpha.id);
    assert.equal((await evaluate(`personalAgentDesktop.listChats()`)).sessions.length,beforeContinue.sessions.length);
    assert.equal(await fs.readFile(path.join(toolsRoot,'approved.txt'),'utf8'),'approved text');
    console.log('PASS core tools: automatic read and workspace file write, forged read-only write denial, approved/declined model command, Escape stops pending command approval, persisted tool results');
    await permission('full');
    await toolSend('full permission write without per-file prompt',[{name:'edit_file',args:{path:'approved.txt',content:'full text'}}]);
    assert.equal(await fs.readFile(path.join(toolsRoot,'approved.txt'),'utf8'),'full text');
    assert.equal(await evaluate(`document.querySelector('.confirm-scrim').classList.contains('is-on')`),false);
    const outsideRoot=await fs.mkdtemp(path.join(artifacts,'outside-workspace-'));
    const outsideFile=path.join(outsideRoot,'outside.txt');
    await fs.writeFile(outsideFile,'OUTSIDE READ EVIDENCE');
    await toolSend('full external read and write',[{name:'read_file',args:{path:outsideFile}},{name:'edit_file',args:{path:outsideFile,content:'OUTSIDE UPDATED'}}]);
    assert.equal(await fs.readFile(outsideFile,'utf8'),'OUTSIDE UPDATED');
    assert.ok(await evaluate(`document.querySelector('#liveChatList').textContent.includes('OUTSIDE READ EVIDENCE')`));
    await selectModel(oldValue);
    await evaluate(`document.querySelector('.confirm-yes').click()`);
    await until(`!document.querySelector('#btnNew').disabled`);
    assert.equal((await evaluate(`personalAgentDesktop.workspace('state')`)).data.permission,'full','model switch preserves operator permission');
    assert.equal((await evaluate(`personalAgentDesktop.listChats()`)).activeSessionId,alpha.id);
    await toolSend('full command no per-call prompt',[{name:'run_command',args:{command:'echo FULL CORE COMMAND'}}]);
    assert.ok(await evaluate(`document.querySelector('#liveChatList').textContent.includes('FULL CORE COMMAND')`));
    // A real mouse click on the unified send/stop control must abort an actual HTTP request.
    async function clickSend() {
      const point=await evaluate(`(()=>{const r=document.querySelector('#sendChat').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
      await cdp('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});
      await cdp('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point});
    }
    const marker=path.join(toolsRoot,'background-marker.txt'), jobScript=path.join(toolsRoot,'background fixture.cjs');
    await fs.writeFile(jobScript,`const fs=require('node:fs');const t=setInterval(()=>fs.appendFileSync(${JSON.stringify(marker)},'x'),40);setTimeout(()=>{clearInterval(t);process.exit(0)},15000);`);
    const jobCommand=`"${process.execPath}" "${jobScript}"`; // Actual model shell must preserve both quoted paths, including spaces.
    toolScenario=[{name:'run_command',args:{command:jobCommand,run_in_background:true}}];toolStep=0;toolHoldFinal=true;toolHeld=0;
    await evaluate(`document.querySelector('#taChat').value='start background then stop whole turn';document.querySelector('#sendChat').click()`);
    for(let i=0;i<100&&!toolHeld;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(toolHeld,1,'model follows up after registered background job starts');
    for(let i=0;i<100;i++){try{if((await fs.stat(marker)).size>0)break;}catch{}await new Promise(r=>setTimeout(r,30));}
    assert.ok((await fs.stat(marker)).size>0,'actual child process produced marker');
    await clickSend();
    await until(`!document.querySelector('#btnNew').disabled&&document.querySelector('#sendChat').dataset.action==='send'`);
    const stopAck=await evaluate(`personalAgentDesktop.stopChat()`);assert.equal(stopAck.ok,true,'host awaits owner job cleanup');
    const frozen=(await fs.stat(marker)).size;await new Promise(r=>setTimeout(r,250));assert.equal((await fs.stat(marker)).size,frozen,'stopping current session actually terminates its background process');
    toolScenario=null;toolHoldFinal=false;
    console.log('PASS full core: outside read/write, model switch retains full permission, command no prompt, actual background process freezes after stop');
    await toolSend('background survives normal model reply',[{name:'run_command',args:{command:jobCommand,run_in_background:true}}]);
    await until(`!document.querySelector('#btnNew').disabled&&document.querySelector('#sendChat').dataset.action==='stop'`);
    assert.equal(await evaluate(`document.querySelector('#sendChat').disabled`),false,'idle owned jobs retain usable stop control');
    for(let i=0;i<100&&(await fs.stat(marker)).size===frozen;i++)await new Promise(r=>setTimeout(r,30));
    assert.ok((await fs.stat(marker)).size>frozen,'background continues after normal model reply');
    await clickSend();await until(`document.querySelector('#sendChat').dataset.action==='send'&&!document.querySelector('#btnNew').disabled`);
    const idleFrozen=(await fs.stat(marker)).size;await new Promise(r=>setTimeout(r,250));assert.equal((await fs.stat(marker)).size,idleFrozen,'idle stop waits for process termination');
    console.log('PASS idle background: completed reply keeps stop entry; native click stops surviving owner job');
    await permission('read');
    const beforeStop=await evaluate(`personalAgentDesktop.listChats()`);
    const cardsBefore=await evaluate(`document.querySelectorAll('#liveChatList .tool-card').length`);
    slowChat=true;
    await evaluate(`(()=>{const t=document.querySelector('#taChat');t.value='cancel slow HTTP';t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await clickSend();
    for(let i=0;i<100&&!slowSeen;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(slowSeen,1);
    assert.equal((await evaluate(`personalAgentDesktop.workspace('permission',{permission:'full'})`)).ok,false,'host denies permission escalation while model is running');
    assert.equal((await evaluate(`personalAgentDesktop.workspace('state')`)).data.permission,'read');
    assert.equal(await evaluate(`document.querySelector('#sendHome').dataset.action`),'stop','both composers share active stop state');
    await until(`document.querySelector('#sendChat').dataset.action==='stop'&&!document.querySelector('#sendChat').disabled`);
    assert.equal(await evaluate(`document.querySelector('#taChat').value`),'','sending clears input but stop remains enabled');
    assert.equal(await evaluate(`document.querySelector('#sendChat').getAttribute('aria-label')`),'停止');
    assert.ok(await evaluate(`document.querySelector('#sendChat use').getAttribute('href').includes('i-stop')`));
    const requestsBeforeStop=sends;
    await clickSend();
    await until(`!document.querySelector('#btnNew').disabled&&document.querySelector('#sendChat').dataset.action==='send'`);
    for(let i=0;i<100&&!slowClosed;i++)await new Promise(r=>setTimeout(r,50));
    assert.equal(slowClosed,1,'mock observes request socket closed by actual stop');
    slowChat=false;
    await new Promise(r=>setTimeout(r,150));
    assert.equal(sends,requestsBeforeStop,'stopping never issues a subsequent model request');
    assert.equal(await evaluate(`document.querySelectorAll('#liveChatList .tool-card').length`),cardsBefore,'no tool runs after stopped model request');
    assert.equal(await fs.readFile(path.join(toolsRoot,'approved.txt'),'utf8'),'full text');
    await turn('taChat','sendChat','continue after real stop',await evaluate(`document.querySelectorAll('#liveChatList .msg--agent').length`)+1);
    const afterStop=await evaluate(`personalAgentDesktop.listChats()`);
    assert.equal(afterStop.activeSessionId,beforeStop.activeSessionId);assert.equal(afterStop.sessions.length,beforeStop.sessions.length);
    console.log('PASS unified send/stop: real mouse click, empty input remains stoppable, socket abort, no subsequent work, same-chat continuation; pending approval stop uses native Escape');
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
