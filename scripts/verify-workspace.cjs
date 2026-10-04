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
    let occupied=false;try{await fetch('http://127.0.0.1:9225/json/list');occupied=true;}catch{}assert.equal(occupied,false,'test debug port is already occupied');
    const env={...process.env,PERSONAL_AGENT_HOME:home};delete env.ELECTRON_RUN_AS_NODE;
    child=spawn(process.execPath,['desktop/launch.cjs','--user-data-dir='+path.join(home,'electron-profile'),'--remote-debugging-address=127.0.0.1','--remote-debugging-port=9225'],{cwd:root,env,stdio:'inherit'});
    async function target(match){for(let i=0;i<100;i++){try{const pages=await(await fetch('http://127.0.0.1:9225/json/list')).json();const p=pages.find(match);if(p)return p;}catch{}await new Promise(r=>setTimeout(r,100));}throw Error('page not found');}
    ws=await connect((await target(p=>p.url.endsWith('/desktop/renderer/index.html'))).webSocketDebuggerUrl);
    assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('state')`)).data.permission,'read');
    for(const url of ['file:///C:/Windows/win.ini','javascript:alert(1)','https://user:pass@example.com'])assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('browser-open',{url:${JSON.stringify(url)}})`)).ok,false);
    assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('terminal',{command:'echo forbidden'})`)).ok,false);
    // 权限提升必须弹客户端自绘确认框（非系统弹窗）；覆盖取消与允许两条路径。
    async function until(expression){for(let i=0;i<100;i++){if(await evaluate(ws,expression))return;await new Promise(r=>setTimeout(r,100));}throw Error('UI condition failed: '+expression);}
    await ws('Runtime.evaluate',{expression:`window.__grant=null;personalAgentDesktop.workspace('permission',{permission:'full'}).then(r=>window.__grant=r)`});
    await until(`!!document.querySelector('.confirm-scrim.is-on')`);
    assert.match(await evaluate(ws,`document.querySelector('.confirm-card h3').textContent`),/允许完整工作区权限/);
    assert.match(await evaluate(ws,`document.querySelector('.confirm-detail').textContent`),/模型仍无工具/);
    const confirmShot=await ws('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(root,'.test-artifacts','workspace-confirm.png'),Buffer.from(confirmShot.data,'base64'));
    await evaluate(ws,`document.querySelectorAll('.confirm-actions button')[0].click()`);
    await until(`window.__grant!==null`);assert.equal((await evaluate(ws,`window.__grant`)).ok,false,'cancel must deny escalation');
    assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('state')`)).data.permission,'read');
    await ws('Runtime.evaluate',{expression:`window.__grant=null;personalAgentDesktop.workspace('permission',{permission:'full'}).then(r=>window.__grant=r)`});
    await until(`!!document.querySelector('.confirm-scrim.is-on')`);
    await evaluate(ws,`document.querySelector('.confirm-actions .confirm-yes').click()`);
    await until(`window.__grant!==null`);assert.equal((await evaluate(ws,`window.__grant`)).ok,true,'accept must grant escalation');
    assert.equal((await evaluate(ws,`personalAgentDesktop.workspace('state')`)).data.permission,'full');
    const url=`http://127.0.0.1:${server.address().port}/`;
    await evaluate(ws,`document.querySelector('#workspaceToggle').click()`);
    for(let i=0;i<50;i++){if(await evaluate(ws,`!!document.querySelector('.workspace-start')`))break;await new Promise(r=>setTimeout(r,100));}
    await evaluate(ws,`document.querySelectorAll('.workspace-start button')[2].click()`);
    await evaluate(ws,`document.querySelector('.workspace-toolbar input').value=${JSON.stringify(url)};document.querySelector('.workspace-toolbar').requestSubmit()`);
    for(let i=0;i<100;i++){if(await evaluate(ws,`document.querySelector('.workspace-toolbar input').value===${JSON.stringify(url)}&&!document.querySelector('.workspace-toolbar button[type=submit]').disabled`))break;await new Promise(r=>setTimeout(r,100));}
    assert.equal(await evaluate(ws,`document.querySelector('.workspace-error').textContent`),'');
    remote=await connect((await target(p=>p.url===url)).webSocketDebuggerUrl);
    assert.deepEqual(await evaluate(remote,`({bridge:typeof window.personalAgentDesktop,require:typeof require,process:typeof process})`),{bridge:'undefined',require:'undefined',process:'undefined'});
    const browserShot=await remote('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(root,'.test-artifacts','browser-content.png'),Buffer.from(browserShot.data,'base64'));
    assert.match(await evaluate(remote,`document.body.textContent`),/ISOLATED BROWSER FIXTURE/);
    const shot=await ws('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(root,'.test-artifacts','workspace-browser.png'),Buffer.from(shot.data,'base64'));
    await evaluate(ws,`personalAgentDesktop.workspace('browser-close')`);
    console.log('PASS workspace: default read-only, command denied, dangerous URLs denied, in-app confirm dialog (cancel+accept), real embedded browser without host bridge');
  }finally{
    try{if(ws)await evaluate(ws,`personalAgentDesktop.windowAction('close')`);}catch{}
    for(const s of sockets)s.close();if(child&&child.exitCode===null)child.kill();server.close();
  }
})().catch(e=>{console.error(e);process.exitCode=1;});
