// Real renderer clicks + IPC + local provider + process restart. Disposable home only.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),http=require('node:http'),net=require('node:net');
const {spawn}=require('node:child_process');
(async()=>{
 const root=path.resolve(__dirname,'..'),artifacts=path.join(root,'.test-artifacts');await fs.mkdir(artifacts,{recursive:true});
 const home=await fs.mkdtemp(path.join(artifacts,'task-restart-')),workspace=await fs.mkdtemp(path.join(artifacts,'task-workspace-'));
 const bootstrap=path.join(home,'bootstrap.cjs');
 await fs.writeFile(bootstrap,`const {dialog}=require('electron');dialog.showMessageBox=async()=>({response:1});require(${JSON.stringify(path.join(root,'desktop/main.cjs'))});`);
 let mode='edit',step=0,requests=0,waiting=false,child,ws,cdp,evaluate,until,click;
 const held=new Set(),pause=ms=>new Promise(r=>setTimeout(r,ms));
 const server=http.createServer(async(req,res)=>{
  try{
   if(req.url==='/v1/models'){res.end(JSON.stringify({data:[{id:'fixture'}]}));return;}
   let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);requests++;
   assert.equal(req.url,'/v1/chat/completions');
   let message={role:'assistant',content:'CLIENT_VERIFIED'};
   const tool=(name,args)=>({role:'assistant',content:'',tool_calls:[{id:'call-'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}}]});
   if(mode==='edit'&&step++===0)message=tool('create_file',{path:'first.txt',content:'preserved'});
   else if(mode==='edit'||mode==='goal-wait'){waiting=true;held.add(res);res.on('close',()=>held.delete(res));return;}
   else if(mode==='goal'&&step++===0)message=tool('create_goal',{objective:'produce final file',criteria:'final.txt is accepted',maxRounds:4});
   else if(mode==='goal'){mode='goal-wait';waiting=true;held.add(res);res.on('close',()=>held.delete(res));return;}
   else if(mode==='resume'&&step++===0)message=tool('create_file',{path:'final.txt',content:'accepted'});
   else if(mode==='resume'&&step===2){assert.equal(await fs.readFile(path.join(workspace,'final.txt'),'utf8'),'accepted');message=tool('update_goal',{status:'complete',summary:'final file created',evidence:'final.txt contains accepted'});}
   if(mode==='continue'){assert.ok(body.messages.some(m=>m.tool_call_id&&m.content));assert.equal(await fs.readFile(path.join(workspace,'first.txt'),'utf8'),'preserved');}
   res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}));
  }catch(e){console.error(e);res.writeHead(500);res.end('{}');}
 });
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 async function boot(){
  const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
  const env={...process.env,PERSONAL_AGENT_HOME:home};for(const k of ['ELECTRON_RUN_AS_NODE','PERSONAL_AGENT_BASE_URL','PERSONAL_AGENT_MODEL','PERSONAL_AGENT_API_KEY'])delete env[k];
  child=spawn(process.env.PERSONAL_AGENT_ELECTRON||require('electron'),[bootstrap,'--user-data-dir='+path.join(home,'profile'),'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port],{cwd:root,env,stdio:'inherit'});
  let page;for(let i=0;i<150&&!page;i++){if(child.exitCode!==null)throw Error('Electron exited');try{page=(await(await fetch('http://127.0.0.1:'+port+'/json/list')).json()).find(p=>p.url.endsWith('/desktop/renderer/index.html'));}catch{}if(!page)await pause(100);}assert.ok(page);
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);pending.get(m.id)?.(m);};
  cdp=async(method,params={})=>{const n=++id;let timer;try{const m=await Promise.race([new Promise(r=>{pending.set(n,r);ws.send(JSON.stringify({id:n,method,params}));}),new Promise((_,j)=>timer=setTimeout(()=>j(Error('CDP '+method)),20000))]);assert.ok(!m.error,JSON.stringify(m.error));return m.result;}finally{clearTimeout(timer);pending.delete(n);}};
  evaluate=async expression=>{const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value;};
  until=async expression=>{for(let i=0;i<180;i++){if(await evaluate(expression))return;await pause(60);}throw Error('UI condition: '+expression);};
  click=async selector=>{const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)return null;e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2,w:r.width,h:r.height};})()`);assert.ok(p?.w&&p.h,'click '+selector);for(const type of ['mousePressed','mouseReleased'])await cdp('Input.dispatchMouseEvent',{type,x:p.x,y:p.y,button:'left',clickCount:1});};
  await until(`!!window.personalAgentDesktop&&!!document.querySelector('#btnNew')&&!document.querySelector('#btnNew').disabled`);
   // Check actual preload isolation on each boot, not just window configuration.
   const info=await evaluate(`personalAgentDesktop.getInfo()`);
   assert.equal(info.sandboxed,true);assert.equal(info.contextIsolated,true);
   assert.equal(await evaluate(`typeof require`),'undefined');
   console.log('BOOT_VERIFIED',JSON.stringify({executable:child.spawnfile,pid:child.pid,electron:info.electron,sandboxed:info.sandboxed,contextIsolated:info.contextIsolated}));
 }
 async function quit(){
  const proc=child;const exited=new Promise(r=>proc.once('exit',r));
  await cdp('Runtime.evaluate',{expression:`personalAgentDesktop.windowAction('close')`}).catch(()=>{});
  await Promise.race([exited,new Promise((_,j)=>setTimeout(()=>j(Error('Electron quit timeout')),15000))]);
  ws.close();assert.equal(proc.exitCode,0);child=undefined;
 }
 async function text(selector,value){await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.value=${JSON.stringify(value)};e.dispatchEvent(new Event('input',{bubbles:true}));})()`);}
 async function send(value){const s=await evaluate(`document.querySelector('#vChat').classList.contains('is-on')?'#taChat':'#taHome'`);await text(s,value);await click(s==='#taChat'?'#sendChat':'#sendHome');}
 async function settled(){await until(`!document.querySelector('#btnNew').disabled&&document.querySelector('#sendChat').dataset.action==='send'`);}
 async function waitProvider(){for(let i=0;i<200&&!waiting;i++)await pause(30);assert.ok(waiting);}
 try{
  await boot();
  const initial=await evaluate(`personalAgentDesktop.providerSettings('list')`),baseUrl='http://127.0.0.1:'+server.address().port+'/v1';
  const saved=await evaluate(`personalAgentDesktop.providerSettings('save',${JSON.stringify({revision:initial.data.revision,provider:{id:'fixture',name:'fixture',kind:'custom',protocol:'openai-chat',baseUrl,apiKey:'local-only',models:['fixture']}})})`);assert.equal(saved.ok,true);
  const fixtureId='desktop-chat-00000000-0000-4000-8000-000000000079';
  await fs.writeFile(path.join(home,fixtureId+'.jsonl'),JSON.stringify({v:1,kind:'session',id:fixtureId,createdAt:new Date().toISOString()})+'\n');
  await require('../desktop/chat-index.cjs').remember(home,{id:fixtureId,title:'restart fixture',workspaceRoot:await fs.realpath(workspace),permission:'write',identity:JSON.stringify(['fixture',baseUrl,'fixture',saved.data.revision])});
  await evaluate(`personalAgentDesktop.openChat(${JSON.stringify(fixtureId)}).then(()=>personalAgentDesktop.resetChat())`);
  await evaluate(`window.dispatchEvent(new Event('providers-changed'));window.dispatchEvent(new Event('workspace-sync'))`);
  await until(`document.querySelector('#taHomeModel').options.length>1`);
  await evaluate(`(()=>{const s=document.querySelector('#taHomeModel');s.value=JSON.stringify({id:'fixture',model:'fixture'});s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await send('Create first.txt then wait');await waitProvider();await until(`document.querySelector('#sendChat').dataset.action==='stop'`);await click('#sendChat');await settled();
  assert.equal(await fs.readFile(path.join(workspace,'first.txt'),'utf8'),'preserved');
  mode='continue';await send('Inspect existing result without replay');await settled();
  const active=(await evaluate(`personalAgentDesktop.listChats()`)).activeSessionId;
  mode='goal';step=0;waiting=false;await send('/goal produce final file until verified');await waitProvider();await click('#sendChat');await settled();
  const before=await evaluate(`personalAgentDesktop.task('get')`);assert.equal(before.data.task.status,'paused');assert.equal(before.data.task.rounds,1);
  const firstPid=child.pid,count=requests;await quit();await boot();assert.notEqual(child.pid,firstPid);
  await until(`!!document.querySelector('.session-row[data-session="${active}"]')`);
  await evaluate(`document.querySelector('.session-row[data-session="${active}"]').closest('details').open=true`);
  await click(`.session-row[data-session="${active}"]`);await until(`document.querySelector('#vChat').classList.contains('is-on')`);
  await pause(500);assert.equal(requests,count,'quit, restart and reopen must not request model automatically');
  assert.equal((await evaluate(`personalAgentDesktop.listChats()`)).activeSessionId,active);
  const after=await evaluate(`personalAgentDesktop.task('get')`);assert.equal(after.data.task.status,'paused');assert.equal(after.data.task.rounds,1);
  mode='resume';step=0;
  await click('#vChat .task-status-chip');await until(`!!document.querySelector('[data-kind=task][open] .task-primary:not(:disabled)')`);
  await click('[data-kind=task] .task-primary');await settled();
  const completed=await evaluate(`personalAgentDesktop.task('get')`);assert.equal(completed.data.task.status,'completed');assert.equal(completed.data.task.rounds,2);
  assert.equal(await fs.readFile(path.join(workspace,'final.txt'),'utf8'),'accepted');
  const history=await fs.readFile(path.join(home,active+'.jsonl'),'utf8');const records=history.trim().split('\n').map(JSON.parse);
  const calls=records.flatMap(r=>r.message?.toolCalls||[]);assert.equal(calls.filter(t=>t.name==='create_file').length,2);
  const shot=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(artifacts,'task-restart-completed.png'),Buffer.from(shot.data,'base64'));
  console.log('PASS real send/stop/continue, Electron quit/relaunch, paused task persistence, manual resume, two artifacts without replay; isolated home='+home);
  await quit();
 }finally{
  ws?.close();if(child&&child.exitCode===null){child.kill();await new Promise(r=>child.once('exit',r));}
  for(const res of held)res.destroy();server.closeAllConnections();await new Promise(r=>server.close(r));
 }
})().catch(e=>{console.error(e);process.exitCode=1;});
