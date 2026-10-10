// Real Electron isolated browser smoke test; no cloud or user workspace access.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
(async()=>{
  const root=path.resolve(__dirname,'..'), home=await fs.mkdtemp(path.join(root,'.test-artifacts','workspace-'));
  const server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<h1>ISOLATED BROWSER FIXTURE</h1>');});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  let child,ws,remote;
  const sockets=[];
  function connect(url){return new Promise((resolve,reject)=>{const socket=new WebSocket(url);socket.onopen=()=>{sockets.push(socket);let id=0;const pending=new Map();socket.onmessage=e=>{const m=JSON.parse(e.data);pending.get(m.id)?.(m);};resolve(async(method,params={})=>{const n=++id;let timer;try{const m=await Promise.race([new Promise(r=>{pending.set(n,r);socket.send(JSON.stringify({id:n,method,params}));}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('CDP timeout')),15000);})]);assert.ok(!m.error,JSON.stringify(m));return m.result;}finally{clearTimeout(timer);pending.delete(n);}});};socket.onerror=reject;});}
  async function evaluate(cdp,expression){const r=await cdp('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true});assert.ok(!r.exceptionDetails,JSON.stringify(r));return r.result.value;}
  try{
    // Ask the OS for an unused port; a bound non-listening socket can defeat an HTTP-only probe.
    const portProbe=require('node:net').createServer();await new Promise((resolve,reject)=>{portProbe.once('error',reject);portProbe.listen(0,'127.0.0.1',resolve);});
    const debugPort=portProbe.address().port;await new Promise(resolve=>portProbe.close(resolve));
    const env={...process.env,PERSONAL_AGENT_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
    child=spawn(process.execPath,['desktop/launch.cjs','--user-data-dir='+path.join(home,'electron-profile'),'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+debugPort],{cwd:root,env,stdio:'inherit'});
    async function target(match){for(let i=0;i<100;i++){try{const pages=await(await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();const p=pages.find(match);if(p)return p;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('page not found');}
    ws=await connect((await target(p=>p.url.endsWith('/desktop/renderer/index.html'))).webSocketDebuggerUrl);
    await until(`document.querySelectorAll('.workspace-controls select').length===2&&document.querySelectorAll('.agent-picker[data-kind="permission"]').length===2`);
    // 浅色：内容面与侧栏同底，新建任务按钮同底、图标用主操作色；深色面必须仍是自己的值。
    const light = await evaluate(ws,`(()=>{const bg=s=>getComputedStyle(document.querySelector(s)).backgroundColor;return {sidebar:bg('.sidebar'),main:bg('.main'),newBtn:bg('.btn-new'),icon:getComputedStyle(document.querySelector('.btn-new .ico')).color,send:bg('.composer .send')};})()`);
    assert.deepEqual([light.main,light.newBtn,light.icon],[light.sidebar,light.sidebar,light.send],'light surfaces and accent');
    await evaluate(ws,`document.documentElement.dataset.theme='dark'`);
    const dark = await evaluate(ws,`getComputedStyle(document.querySelector('.main')).backgroundColor`);
    await evaluate(ws,`document.documentElement.dataset.theme='light'`);
    assert.equal(dark,'rgb(27, 23, 20)','dark content surface must keep its own value');
    assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('state')`)).data.permission,'write');
    assert.equal(Object.hasOwn((await evaluate(ws,`personalAgentDesktop.workspace('state')`)).data,'modelTools'),false);
    assert.equal(await evaluate(ws,`!!document.querySelector('#btnStop,#btnStopHome,[data-action="test-tools"]')`),false);
    assert.deepEqual(await evaluate(ws,`Array.from(document.querySelectorAll('.workspace-controls select')).map(s=>Array.from(s.options).map(o=>o.value))`),[['read','write','full'],['read','write','full']]);
    for(const url of ['file:///C:/Windows/win.ini','javascript:alert(1)','https://user:pass@example.com'])assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('browser-open',{url:${JSON.stringify(url)}})`)).ok,false);
    assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('terminal',{command:'echo forbidden'})`)).ok,false);
    // Seed a disposable indexed history to restore a real workspace without driving the native picker.
    const fixtureId='desktop-chat-00000000-0000-4000-8000-000000000001';
    const fixtureRoot=await fs.realpath(home);
    await fs.writeFile(path.join(home,fixtureId+'.jsonl'),JSON.stringify({v:1,kind:'session',id:fixtureId,createdAt:new Date().toISOString()})+'\n');
    await require('../desktop/chat-index.cjs').remember(home,{id:fixtureId,title:'workspace fixture',workspaceRoot:fixtureRoot,identity:JSON.stringify(['missing','http://127.0.0.1:1/v1','fixture',0])});
    await evaluate(ws,`personalAgentDesktop.openChat(${JSON.stringify(fixtureId)})`);
    assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('state')`)).data.root,fixtureRoot);
    await fs.writeFile(path.join(home,'preview-return.html'),'<h1>RETURNABLE PREVIEW</h1>');
    await evaluate(ws,`window.dispatchEvent(new CustomEvent('deliverable-open',{detail:{path:'preview-return.html'}}))`);
    await until(`document.querySelector('#workspaceFileTab').textContent==='preview-return.html'&&!!document.querySelector('.workspace-browser')`);
    assert.equal(await evaluate(ws,`document.querySelector('#workspaceAdd').textContent`),'＋');
    async function viewportFits(){await until(`(()=>{const p=document.querySelector('.workspace-panel').getBoundingClientRect(),h=document.querySelector('.workspace-panel header').getBoundingClientRect(),v=document.querySelector('.workspace-browser').getBoundingClientRect();return Math.abs(v.bottom-p.bottom)<2&&Math.abs(v.top-h.bottom)<2&&Math.abs(v.right-p.right)<2&&v.left-p.left<2&&h.height<=50;})()`);}
    const previewCdp=await connect((await target(p=>p.url.startsWith('data:text/html'))).webSocketDebuggerUrl);
    for(let i=0;i<100;i++){if(await evaluate(previewCdp,`document.readyState==='complete'&&!!document.body`))break;await new Promise(r=>setTimeout(r,50));}
    assert.match(await evaluate(previewCdp,`document.body.textContent`),/RETURNABLE PREVIEW/);
    await viewportFits();await evaluate(ws,`document.querySelector('#workspaceFullscreen').click()`);await viewportFits();
    await previewCdp('Page.captureScreenshot',{format:'png'});const slotSize=await evaluate(ws,`(()=>{const r=document.querySelector('.workspace-browser').getBoundingClientRect();return [Math.floor(r.width),Math.floor(r.height)];})()`);for(let i=0;i<100;i++){if(JSON.stringify(await evaluate(previewCdp,`[innerWidth,innerHeight]`))===JSON.stringify(slotSize))break;await new Promise(r=>setTimeout(r,50));}assert.equal(await evaluate(ws,`document.querySelector('.workspace-error').textContent`),'');assert.deepEqual(await evaluate(previewCdp,`[innerWidth,innerHeight]`),slotSize,'native embedded page must fill slot, not only a CSS placeholder');
    await ws('Emulation.setDeviceMetricsOverride',{width:800,height:700,deviceScaleFactor:1,mobile:false});await viewportFits();await shot('preview-compact-narrow');await ws('Emulation.clearDeviceMetricsOverride');await evaluate(ws,`document.querySelector('#workspaceFullscreen').click()`);await viewportFits();
    await evaluate(ws,`document.querySelector('#workspaceAdd').click()`);await until(`document.querySelector('.workspace-add-menu').matches(':popover-open')`);
    await evaluate(ws,`document.querySelector('.workspace-add-menu').hidePopover();document.querySelector('.workspace-tab button').click()`);await until(`!document.querySelector('.preview-controls').hidden&&!!document.querySelector('.workspace-browser')`);
    await until(`!!document.querySelector('#previewMore')&&!document.querySelector('#previewMore').disabled`);
    assert.deepEqual(await evaluate(ws,`Array.from(document.querySelectorAll('.preview-controls button')).map(n=>n.textContent)`),['↻','…']);
    assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('browser-tool',{tool:'invalid'})`)).ok,false);
    assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('browser-tool',{tool:'device'})`)).data.device,true);
    const inspected=await connect((await target(p=>p.url.startsWith('data:text/html'))).webSocketDebuggerUrl);
    assert.equal(await evaluate(inspected,`screen.width`),390);
    assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('browser-tool',{tool:'device'})`)).data.device,false);
    assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('browser-tool',{tool:'select'})`)).data.selecting,true);
    assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('browser-tool',{tool:'css'})`)).ok,true);
    if(process.env.PA_VERIFY_VISUAL==='1')await require('./verify-visual-inspector.cjs')({ws,inspected,evaluate,until,shot});
    assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('browser-tool',{tool:'devtools'})`)).data.opened,true);
    const dev=await connect((await target(p=>p.url.startsWith('devtools://'))).webSocketDebuggerUrl);
    let inspectorReady=false;for(let i=0;i<100;i++){if(await evaluate(dev,`document.readyState==='complete'&&!!document.querySelector('.root-view')`)){inspectorReady=true;break;}await new Promise(r=>setTimeout(r,100));}assert.ok(inspectorReady,'native DevTools frontend must actually load, not merely create target');
    assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('browser-tool',{tool:'devtools'})`)).data.opened,true);
    assert.deepEqual(await evaluate(inspected,`({bridge:typeof personalAgentDesktop,node:typeof require})`),{bridge:'undefined',node:'undefined'});
    await evaluate(ws,`document.querySelector('#workspaceToggle').click()`);await until(`document.querySelector('.workspace-panel').hidden`);
    // 权限提升必须弹客户端自绘确认框（非系统弹窗）；覆盖取消与允许两条路径。
    async function until(expression){for(let i=0;i<100;i++){if(await evaluate(ws,expression))return;await new Promise(r=>setTimeout(r,100));}throw Error('UI condition failed: '+expression);}
    await ws('Runtime.evaluate',{expression:`window.__grant=null;personalAgentDesktop.workspace('permission',{permission:'full'}).then(r=>window.__grant=r)`});
    await until(`!!document.querySelector('.confirm-scrim.is-on')`);
    assert.match(await evaluate(ws,`document.querySelector('.confirm-card h3').textContent`),/允许完整权限/);
    assert.match(await evaluate(ws,`document.querySelector('.confirm-detail').textContent`),/没有操作系统沙箱/);
    const confirmShot=await ws('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(root,'.test-artifacts','workspace-confirm.png'),Buffer.from(confirmShot.data,'base64'));
    await evaluate(ws,`document.querySelectorAll('.confirm-actions button')[0].click()`);
    await until(`window.__grant!==null`);assert.equal((await evaluate(ws,`window.__grant`)).ok,false,'cancel must deny escalation');
    assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('state')`)).data.permission,'write');
    await ws('Runtime.evaluate',{expression:`window.__grant=null;personalAgentDesktop.workspace('permission',{permission:'full'}).then(r=>window.__grant=r)`});
    await until(`!!document.querySelector('.confirm-scrim.is-on')`);
    await evaluate(ws,`document.querySelector('.confirm-actions .confirm-yes').click()`);
    await until(`window.__grant!==null`);assert.equal((await evaluate(ws,`window.__grant`)).ok,true,'accept must grant escalation');
    assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('state')`)).data.permission,'full');
    const command=await evaluate(ws,`personalAgentDesktop.workspace('terminal',{command:'echo FULL MANUAL COMMAND'})`);
    assert.equal(command.ok,true);assert.match(command.data.output,/FULL\s+MANUAL\s+COMMAND/);
    assert.equal(await evaluate(ws,`!!document.querySelector('.confirm-scrim.is-on')`),false,'full manual command does not reopen per-call approval');
    const url=`http://127.0.0.1:${server.address().port}/`;
    await evaluate(ws,`document.querySelector('#workspaceToggle').click()`);
    await until(`!document.querySelector('.workspace-panel').hidden`);
    async function shot(name){await new Promise(r=>setTimeout(r,350));const r=await ws('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(root,'.test-artifacts',name+'.png'),Buffer.from(r.data,'base64'));}
    async function rect(){return evaluate(ws,`(()=>{const r=document.querySelector('.workspace-panel').getBoundingClientRect();return {left:r.left,width:r.width,right:r.right};})()`);}
    const initial=await rect();
    // 按下后必须真的收到 pointermove；只剩 lostpointercapture 说明拖拽被打断（原生预览视图被隐藏会释放捕获）。
    const grip=await evaluate(ws,`(()=>{const r=document.querySelector('.workspace-splitter').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+150};})()`);
    await evaluate(ws,`(()=>{window.__grip=[];const s=document.querySelector('.workspace-splitter');['pointerdown','pointermove','pointerup','lostpointercapture'].forEach(t=>s.addEventListener(t,()=>window.__grip.push(t)))})()`);
    await ws('Input.dispatchMouseEvent',{type:'mousePressed',x:grip.x,y:grip.y,button:'left',clickCount:1});
    await ws('Input.dispatchMouseEvent',{type:'mouseMoved',x:grip.x-60,y:grip.y,button:'left',buttons:1});
    await ws('Input.dispatchMouseEvent',{type:'mouseMoved',x:grip.x-150,y:grip.y,button:'left',buttons:1});
    await ws('Input.dispatchMouseEvent',{type:'mouseReleased',x:grip.x-150,y:grip.y,button:'left',clickCount:1});
    const gripTrace=await evaluate(ws,`window.__grip.join('>')`);
    assert.ok(gripTrace.includes('pointermove'),'splitter drag never delivered a pointermove, trace: '+gripTrace);
    const resized=await rect();assert.ok(resized.width>initial.width+100,'real splitter drag expands panel');assert.equal(await evaluate(ws,`document.body.classList.contains('workspace-resizing')`),false);await shot('workspace-resized');
    await evaluate(ws,`document.querySelector('#workspaceFullscreen').click()`);await until(`document.body.classList.contains('workspace-full')`);const expanded=await rect();assert.ok(expanded.width>resized.width);assert.equal(await evaluate(ws,`getComputedStyle(document.querySelector('.main')).visibility`),'hidden');await shot('workspace-fullscreen');
    await ws('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,modifiers:3});await ws('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});assert.ok(Math.abs((await rect()).width-resized.width)<2,'shortcut restores split width');
    await evaluate(ws,`document.querySelector('.workspace-splitter').focus()`);await ws('Input.dispatchKeyEvent',{type:'keyDown',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});await ws('Input.dispatchKeyEvent',{type:'keyUp',key:'ArrowRight',code:'ArrowRight',windowsVirtualKeyCode:39});assert.ok(Math.abs((await rect()).width-resized.width+16)<2,'keyboard separator resize');
    await ws('Emulation.setDeviceMetricsOverride',{width:800,height:700,deviceScaleFactor:1,mobile:false});await until(`document.querySelector('.workspace-panel').getBoundingClientRect().right<=innerWidth`);await evaluate(ws,`document.querySelector('#workspaceFullscreen').click()`);await shot('workspace-fullscreen-narrow');assert.ok((await rect()).left>=0);await ws('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});await ws('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});assert.equal(await evaluate(ws,`document.body.classList.contains('workspace-full')`),false);await ws('Emulation.clearDeviceMetricsOverride');
    const chosen=await rect();await evaluate(ws,`document.querySelector('#workspaceToggle').click();document.querySelector('#workspaceToggle').click()`);await until(`!document.querySelector('.workspace-panel').hidden`);assert.ok(Math.abs((await rect()).width-chosen.width)<2,'reopening preserves chosen width');
    await evaluate(ws,`document.querySelector('#workspaceAdd').click();document.querySelectorAll('.workspace-add-menu button')[2].click()`);
    await until(`!!document.querySelector('.workspace-toolbar input')`);
    await evaluate(ws,`document.querySelector('.workspace-toolbar input').value=${JSON.stringify(url)};document.querySelector('.workspace-toolbar').requestSubmit()`);
    for(let i=0;i<100;i++){if(await evaluate(ws,`document.querySelector('.workspace-toolbar input').value===${JSON.stringify(url)}&&!document.querySelector('.workspace-toolbar button[type=submit]').disabled`))break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(await evaluate(ws,`document.querySelector('.workspace-error').textContent`),'');
    remote=await connect((await target(p=>p.url===url)).webSocketDebuggerUrl);
    assert.deepEqual(await evaluate(remote,`({bridge:typeof window.personalAgentDesktop,require:typeof require,process:typeof process})`),{bridge:'undefined',require:'undefined',process:'undefined'});
    const browserShot=await remote('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(root,'.test-artifacts','browser-content.png'),Buffer.from(browserShot.data,'base64'));
    assert.match(await evaluate(remote,`document.body.textContent`),/ISOLATED BROWSER FIXTURE/);
    await evaluate(remote,`window.retainedTabValue=73`);
    await evaluate(ws,`document.querySelector('#workspaceAdd').click();document.querySelectorAll('.workspace-add-menu button')[1].click()`);await until(`!!document.querySelector('.workspace-toolbar input[aria-label="终端命令"]')`);
    await evaluate(ws,`document.querySelector('.workspace-toolbar input').value='retained command';document.querySelectorAll('.workspace-tab button')[2].click()`);await until(`!!document.querySelector('.workspace-toolbar input[aria-label="网页地址"]')`);
    assert.equal(await evaluate(remote,`window.retainedTabValue`),73,'browser tab remains alive');
    await evaluate(ws,`document.querySelectorAll('.workspace-tab button')[4].click()`);await until(`document.querySelector('.workspace-toolbar input')?.value==='retained command'`);
    await fs.writeFile(path.join(home,'long-code.md'),'# Code preview\n\n```js\n'+Array.from({length:30},(_,i)=>'const line'+i+' = '+i+';').join('\n')+'\n```\n\nAfter code');
    await evaluate(ws,`window.dispatchEvent(new CustomEvent('deliverable-open',{detail:{path:'long-code.md'}}))`);await until(`!!document.querySelector('.preview-body pre')`);
    assert.ok(await evaluate(ws,`document.querySelector('.preview-body pre').getBoundingClientRect().height>250`),'markdown code must not flex-shrink to a line');
    await shot('workspace-markdown-tabs');
    await evaluate(ws,`document.querySelector('#workspaceAdd').click()`);await until(`document.querySelector('.workspace-add-menu').matches(':popover-open')`);await shot('workspace-plus-menu');await evaluate(ws,`document.querySelector('.workspace-add-menu').hidePopover()`);
    await evaluate(ws,`document.querySelectorAll('.workspace-tab button')[7].click()`);await until(`document.querySelectorAll('.workspace-tab').length===3`);
    await evaluate(ws,`document.querySelectorAll('.workspace-tab button')[2].click()`);await until(`!!document.querySelector('.workspace-toolbar input[aria-label="网页地址"]')`);
    await shot('workspace-browser');
    await evaluate(ws,`document.querySelector('#workspaceFullscreen').click()`);await until(`document.body.classList.contains('workspace-full')`);
    await until(`document.querySelector('.workspace-browser').clientWidth>700`);const fullSlot=await evaluate(ws,`Math.floor(document.querySelector('.workspace-browser').getBoundingClientRect().width)`);for(let i=0;i<50&&(await evaluate(remote,`innerWidth`))!==fullSlot;i++)await new Promise(r=>setTimeout(r,50));assert.equal(await evaluate(remote,`innerWidth`),fullSlot,'native browser follows fullscreen slot');
    await evaluate(ws,`document.querySelector('#workspaceFullscreen').click()`);await evaluate(ws,`personalAgentDesktop.workspace('browser-close')`);
    const verify=spawn(process.execPath,['scripts/verify-desktop.cjs'],{cwd:root,env:{...process.env,PA_VERIFY_PORT:String(debugPort),PA_VERIFY_WORKSPACE:'1',PA_VERIFY_NO_SCREENSHOTS:'1'},stdio:'inherit'});assert.equal(await new Promise(r=>verify.on('exit',r)),0,'generic desktop checks');
    console.log('PASS workspace: default workspace write, command denied, dangerous URLs denied, in-app confirm dialog (cancel+accept), real embedded browser without host bridge');
  }finally{
    try{if(ws)await evaluate(ws,`personalAgentDesktop.windowAction('close')`);}catch{}
    for(const s of sockets)s.close();if(child&&child.exitCode===null)child.kill();server.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
