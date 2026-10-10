// Isolated actual client + CDP. Synthetic IPC drives the production renderer; no provider requests.
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),net=require('node:net'),{spawn}=require('node:child_process');
(async()=>{
 const root=path.resolve(__dirname,'..'),artifacts=path.join(root,'.test-artifacts');await fs.mkdir(artifacts,{recursive:true});const home=await fs.mkdtemp(path.join(artifacts,'agent-states-'));
 const probe=net.createServer();await new Promise(r=>probe.listen(0,'127.0.0.1',r));const port=probe.address().port;await new Promise(r=>probe.close(r));
 const env={...process.env,PERSONAL_AGENT_HOME:home};for(const key of ['PERSONAL_AGENT_BASE_URL','PERSONAL_AGENT_MODEL','PERSONAL_AGENT_API_KEY','ELECTRON_RUN_AS_NODE'])delete env[key];
 let child,ws;const pause=ms=>new Promise(r=>setTimeout(r,ms));
 try{
  child=spawn(process.execPath,['desktop/launch.cjs','--user-data-dir='+path.join(home,'profile'),'--remote-debugging-address=127.0.0.1','--remote-debugging-port='+port],{cwd:root,env,stdio:'inherit'});
  let page;for(let i=0;i<120&&!page;i++){try{page=(await(await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(p=>p.url.endsWith('/desktop/renderer/index.html'));}catch{}if(!page)await pause(100);}assert.ok(page);
  ws=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{ws.onopen=r;ws.onerror=j;});let id=0;const pending=new Map();ws.onmessage=e=>{const m=JSON.parse(e.data);pending.get(m.id)?.(m);};
  async function cdp(method,params={}){const n=++id;let timer;try{const m=await Promise.race([new Promise(r=>{pending.set(n,r);ws.send(JSON.stringify({id:n,method,params}));}),new Promise((_,j)=>timer=setTimeout(()=>j(Error('CDP '+method)),20000))]);assert.ok(!m.error,JSON.stringify(m.error));return m.result;}finally{clearTimeout(timer);pending.delete(n);}}
  async function evaluate(expression){const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});assert.ok(!r.exceptionDetails,JSON.stringify(r.exceptionDetails));return r.result.value;}
  async function until(expression){for(let i=0;i<150;i++){if(await evaluate(expression))return;await pause(40);}throw Error('Condition '+expression);}
  await until(`document.readyState==='complete'&&!!window.AgentTurn&&!document.querySelector('#btnNew').disabled`);await pause(300);
  // Reload isolated shell with test IPC before app scripts mount. Production preload/user state untouched.
  await cdp('Page.addScriptToEvaluateOnNewDocument',{source:`
    window.__fixture={stream:null,activity:null,pending:null,stops:0};const f=window.__fixture;
    const api={providerSettings:async()=>({ok:true,data:{revision:'fixture',providers:[{id:'f',name:'状态验收',baseUrl:'http://fixture.invalid',models:['fixture']} ]}}),listChats:async()=>({sessions:[]}),getProvider:async()=>({providerId:'f',baseUrl:'http://fixture.invalid',model:'fixture',revision:'fixture',token:'fixture'}),onChatStream:cb=>f.stream=cb,onChatActivity:cb=>f.activity=cb,sendChat:()=>new Promise(r=>f.pending=r),stopChat:async()=>{f.stops++;if(f.stopMode==='reject')throw Error('synthetic stop failure');if(f.stopMode==='noop')return {ok:true,stopped:false};f.pending?.({error:'cancelled',content:'',backgroundJobs:0});return {ok:true,stopped:true};},openChat:async()=>({title:'历史状态验收',identity:'fixture',messages:[{role:'user',content:'历史请求'},{role:'assistant',content:'历史过程说明',toolCalls:[{id:'h',name:'get_goal',arguments:'{}'}]},{role:'tool',toolCallId:'h',content:'{}'},{role:'assistant',content:'历史最终答复'},{role:'user',content:'仅落盘用户消息的失败请求'}],failed:true,canResume:true}),task:async()=>({ok:true,data:{task:null}})};
    Object.defineProperty(window,'mountMainChat',{configurable:true,get(){return window.__mount;},set(fn){window.__mount=opts=>{window.fixtureChat=fn({...opts,api,refreshSessions:async()=>{}});return window.fixtureChat;};}});
  `});await cdp('Page.enable');await cdp('Page.reload');await until(`!!window.fixtureChat&&!!window.AgentTurn&&!fixtureChat.isBusy()`);
  await evaluate(`document.querySelector('#toast')?.classList.remove('is-on')`);
  async function start(){await evaluate(`void fixtureChat.send('检查状态层并验证折叠行为',document.querySelector('#taHome'))`);await until(`!!__fixture.pending&&!!document.querySelector('#liveChatList .agent-turn')`);}
  const live=`document.querySelector('#liveChatList .agent-turn:last-child')`;
  await start();assert.equal(await evaluate(`${live}.dataset.state`),'thinking');
  await evaluate(`__fixture.stream({token:'fixture',start:true,responseId:'s1'});__fixture.stream({token:'fixture',responseId:'s1',text:'我先检查执行证据。',reasoning:'检查状态变化与用户折叠覆盖。'});`);await pause(100);
  assert.equal(await evaluate(`${live}.dataset.state`),'streaming');assert.equal(await evaluate(`${live}.querySelector('.agent-think').dataset.open`),'false');
  await evaluate(`${live}.querySelector('.agent-think__head').click();__fixture.stream({token:'fixture',responseId:'s1',tool:{index:0,name:'get_goal',argumentChars:2}});__fixture.stream({token:'fixture',responseId:'s1',complete:true});__fixture.activity({type:'tool-start',name:'get_goal',callId:'a',arguments:'{}'});`);
  assert.equal(await evaluate(`${live}.dataset.state`),'running');assert.equal(await evaluate(`${live}.querySelector('.agent-think').dataset.open`),'true');
  assert.equal(await evaluate(`getComputedStyle(${live}.querySelector('.agent-tool__body')).display`),'block');
  await evaluate(`${live}.querySelector('.agent-tool').dataset.open='false'`);assert.equal(await evaluate(`getComputedStyle(${live}.querySelector('.agent-tool__body')).display`),'block','CSS guarantees running visibility');
  await evaluate(`__fixture.activity({type:'tool-end',name:'get_goal',callId:'a',isError:false,content:'即时工具结果'});`);
  assert.match(await evaluate(`${live}.querySelector('.agent-tool__body').textContent`),/请求参数.*执行结果.*即时工具结果/s,'tool evidence must arrive before whole-turn result');
  await evaluate(`__fixture.stream({token:'fixture',start:true,responseId:'s2'});__fixture.stream({token:'fixture',responseId:'s2',text:'状态层验证完成。'});__fixture.stream({token:'fixture',responseId:'s2',complete:true});__fixture.pending({content:'## 已完成\\n状态切换和执行证据正常。',toolStatus:{offered:['get_goal'],requested:1,completed:1,failed:0},transcript:[{kind:'call',callId:'a',name:'get_goal',arguments:'{}'},{kind:'result',callId:'a',name:'get_goal',content:'<script>window.injected=1</script>',isError:false}],usageSummary:{totalTokens:1200}});__fixture.pending=null;`);await until(`!fixtureChat.isBusy()`);
  assert.equal(await evaluate(`${live}.dataset.state`),'done');assert.equal(await evaluate(`document.querySelectorAll('#liveChatList .agent-turn').length`),1);assert.equal(await evaluate(`${live}.querySelectorAll('.agent-tool[data-call-id="a"]').length`),1);assert.equal(await evaluate(`${live}.querySelector('.agent-think').dataset.open`),'true');assert.equal(await evaluate(`${live}.querySelector('.agent-tool').dataset.open`),'false');assert.equal(await evaluate(`window.injected`),undefined);
  assert.equal(await evaluate(`${live}.querySelectorAll('[data-call-id="a"] [data-kind="result"]').length`),1,'final transcript updates live evidence instead of duplicating');
  assert.match(await evaluate(`${live}.querySelector('[data-call-id="a"] [data-kind="result"]').textContent`),/<script>/);
  assert.match(await evaluate(`${live}.querySelector('.agent-turn__label').textContent`),/完成.*\d.*1200 tokens/);
  assert.equal(await evaluate(`getComputedStyle(${live}.querySelector('.agent-actions')).opacity`),'1');
  assert.equal(await evaluate(`${live}.querySelectorAll('.agent-actions button').length`),1);
  assert.equal(await evaluate(`${live}.querySelector('.agent-actions').textContent`),'');
  assert.equal(await evaluate(`${live}.querySelector('.agent-actions button').getAttribute('aria-label')`),'复制答复');
  assert.equal(await evaluate(`!!${live}.querySelector('.agent-actions svg')`),true);
  await evaluate(`Object.defineProperty(navigator.clipboard,'writeText',{configurable:true,value:async text=>{window.__copiedAnswer=text;}});${live}.querySelector('.agent-actions button').click();`);
  await until(`${live}.querySelector('.agent-actions button').title==='已复制'`);
  assert.match(await evaluate(`window.__copiedAnswer`),/状态切换和执行证据正常/);
  assert.equal(await evaluate(`${live}.querySelector('.agent-actions').textContent`),'');
  // Pure policy transition and user override use the same production component.
  assert.equal(await evaluate(`(()=>{const p=AgentTurnPolicy.defaultOpen;return p({kind:'conclusion',status:'done'},'done')&&!p({kind:'conclusion',status:'done'},'failed');})()`),true);
  await evaluate(`window.fixtureTurn=new AgentTurn({mount:document.querySelector('#liveChatList')});window.fixtureCard=fixtureTurn.step({name:'验证工具 · 操作失败',status:'failed'});fixtureCard.append('预期的合成错误，仅验证失败展示。');fixtureTurn.alert('验证命令失败：这里保留可见原因。');fixtureTurn.finish('failed');void 0;`);
  assert.equal(await evaluate(`fixtureCard.root.dataset.open`),'true');await evaluate(`fixtureCard.button.click();fixtureTurn.setState('failed');void 0`);assert.equal(await evaluate(`fixtureCard.root.dataset.open`),'false');assert.equal(await evaluate(`getComputedStyle(fixtureCard.body).display`),'none');
  await evaluate(`fixtureCard.button.click()`);
  await evaluate(`document.querySelector('#chatScroll').scrollTop=document.querySelector('#chatScroll').scrollHeight;document.querySelector('#toast')?.classList.remove('is-on')`);
  for(const theme of ['light','dark']){await evaluate(`document.documentElement.dataset.theme='${theme}'`);
    const colors=await evaluate(`(()=>{const s=getComputedStyle(document.documentElement);return ['--ag-brand','--ag-surface-2','--ag-warn','--ag-err-bg'].map(k=>s.getPropertyValue(k).trim().toUpperCase());})()`);
    assert.deepEqual(colors,theme==='light'?['#B04E30','#F7F3EC','#8F6220','#F6E3E1']:['#E07A57','#14110E','#E0A84A','#372420'],'handoff Paper/Ink colors must not inherit legacy blue/gray');
    assert.equal(await evaluate(`getComputedStyle(document.querySelector('.sidebar')).backgroundColor`),theme==='light'?'rgb(244, 239, 230)':'rgb(23, 19, 16)');
    await pause(200);const r=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(artifacts,'agent-states-'+theme+'.png'),Buffer.from(r.data,'base64'));}
  await cdp('Emulation.setDeviceMetricsOverride',{width:2560,height:1392,deviceScaleFactor:1,mobile:false});await pause(250);
  assert.equal(await evaluate(`(()=>{const list=document.querySelector('#liveChatList').getBoundingClientRect(),main=document.querySelector('#vChat').getBoundingClientRect();return list.width/main.width>.85;})()`),true,'wide desktop should use available chat area');
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.task-status-chip')).every(n=>!!n.closest('.composer'))`),true,'task control stays with composer, not window corner');
  await evaluate(`document.querySelector('#liveChatList [data-call-id="a"] .agent-tool__head').click();document.querySelector('#chatScroll').scrollTop=document.querySelector('#chatScroll').scrollHeight;document.documentElement.dataset.theme='light'`);await pause(200);
  const wide=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(artifacts,'chat-evidence-wide.png'),Buffer.from(wide.data,'base64'));
  await cdp('Emulation.setDeviceMetricsOverride',{width:800,height:700,deviceScaleFactor:1,mobile:false});await cdp('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await pause(300);
  await evaluate(`document.querySelector('.sidebar').classList.remove('is-open');document.querySelector('#chatScroll').scrollTop=document.querySelector('#chatScroll').scrollHeight`);await pause(250);
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('#liveChatList .agent-turn')).every(n=>{const r=n.getBoundingClientRect();return r.left>=0&&r.right<=innerWidth+1&&n.scrollWidth<=n.clientWidth+1;})`),true);
  assert.equal(await evaluate(`(()=>{fixtureTurn.setState('running');return getComputedStyle(fixtureTurn.dot).animationName;})()`),'none');
  await evaluate(`fixtureTurn.setState('failed');void 0`);
  const narrow=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(artifacts,'agent-states-narrow.png'),Buffer.from(narrow.data,'base64'));
  await evaluate(`fixtureTurn.root.remove();__fixture.pending=null;`);await start();await evaluate(`void fixtureChat.stop()`);await until(`!fixtureChat.isBusy()`);
  assert.equal(await evaluate(`${live}.dataset.state`),'stopped');assert.equal(await evaluate(`${live}.querySelector('.agent-alert').dataset.level`),'warn');assert.equal(await evaluate(`__fixture.stops`),1);
  assert.equal(await evaluate(`${live}.dataset.interruptible`),'false');
  await evaluate(`document.querySelector('#chatScroll').scrollTop=document.querySelector('#chatScroll').scrollHeight`);const stoppedShot=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(path.join(artifacts,'agent-states-stopped.png'),Buffer.from(stoppedShot.data,'base64'));
  await evaluate(`__fixture.pending=null`);await start();
  await evaluate(`__fixture.stream({token:'fixture',start:true,responseId:'f1'});__fixture.stream({token:'fixture',responseId:'f1',text:'尚未验证的片段'});__fixture.stream({token:'fixture',responseId:'f1',retry:{delayMs:1000,attempt:1}});__fixture.stream({token:'fixture',start:true,responseId:'f2'});__fixture.pending({error:'合成请求失败',content:''});__fixture.pending=null;`);await until(`!fixtureChat.isBusy()`);
  assert.equal(await evaluate(`${live}.dataset.state`),'failed');assert.equal(await evaluate(`${live}.querySelector('.agent-alert').dataset.level`),'error');assert.equal(await evaluate(`${live}.querySelectorAll('.retry-note').length`),1,'retry evidence survives next model step');
  assert.equal(await evaluate(`${live}.querySelectorAll('.agent-tool[data-status="stopped"]').length`),1,'interrupted preview retained as process not answer');
  for(const mode of ['reject','noop']){await evaluate(`__fixture.pending=null;__fixture.stopMode='${mode}'`);await start();await evaluate(`fixtureChat.stop();void 0`);await pause(50);await evaluate(`__fixture.pending({content:'请求在停止确认前正常返回',toolStatus:{offered:[],requested:0,completed:0,failed:0}});__fixture.pending=null`);await until(`!fixtureChat.isBusy()`);assert.equal(await evaluate(`${live}.dataset.state`),'done');assert.match(await evaluate(`${live}.querySelector('.agent-alert').textContent`),/停止请求未获确认/);}
  // Synthetic streams exercise production scrolling without provider requests.
   await evaluate(`__fixture.pending=null`);await start();
   // Earlier scenarios leave an arbitrary reading position; explicitly establish
   // the bottom-follow precondition without relying on send() forcing a scroll.
   await evaluate(`document.querySelector('#chatScroll').scrollTop=document.querySelector('#chatScroll').scrollHeight;document.querySelector('#chatScroll').dispatchEvent(new Event('scroll'));`);await pause(150);
   assert.equal(await evaluate(`(()=>{const s=document.querySelector('#chatScroll');return s.scrollHeight-s.clientHeight-s.scrollTop<=5;})()`),true,'reader starts at bottom before streaming');
   await evaluate(`__fixture.stream({token:'fixture',start:true,responseId:'scroll1'});__fixture.stream({token:'fixture',responseId:'scroll1',text:'正文内容\\n'.repeat(140),reasoning:'推理内容\\n'.repeat(100)});`);await pause(200);
   const bottom=`(()=>{const s=document.querySelector('#chatScroll');return s.scrollHeight-s.clientHeight-s.scrollTop<=5;})()`;
   assert.equal(await evaluate(bottom),true,'stream follows while reader is at bottom');
   await evaluate(`${live}.querySelector('.agent-think__head').click()`);await pause(100);
   const reason=`${live}.querySelector('.provider-reasoning')`;
   assert.equal(await evaluate(`${reason}.scrollHeight>${reason}.clientHeight+50`),true,'reasoning fixture must overflow');
   await evaluate(`${reason}.scrollTop=0;__fixture.stream({token:'fixture',responseId:'scroll1',reasoning:'新增推理\\n'.repeat(10)});`);await pause(150);
   assert.equal(await evaluate(`${reason}.scrollTop`),0,'reading earlier reasoning must not jump to bottom');
   await evaluate(`${reason}.scrollTop=${reason}.scrollHeight;__fixture.stream({token:'fixture',responseId:'scroll1',reasoning:'继续推理\\n'.repeat(10)});`);await pause(150);
   assert.equal(await evaluate(`${reason}.scrollHeight-${reason}.clientHeight-${reason}.scrollTop<=5`),true,'reasoning resumes following at bottom');
   const point=await evaluate(`(()=>{const r=document.querySelector('#chatScroll').getBoundingClientRect();return {x:r.left+r.width/2,y:r.top+r.height/2};})()`);
   await cdp('Input.dispatchMouseEvent',{type:'mouseWheel',...point,deltaX:0,deltaY:-350});await pause(150);
   assert.equal(await evaluate(bottom),false,'real wheel input moves chat away from bottom');
   const readingTop=await evaluate(`document.querySelector('#chatScroll').scrollTop`);
   await evaluate(`__fixture.stream({token:'fixture',responseId:'scroll1',text:'新增正文\\n'.repeat(30)});`);await pause(150);
   assert.ok(Math.abs(await evaluate(`document.querySelector('#chatScroll').scrollTop`)-readingTop)<=5,'stream preserves reader position');
   await evaluate(`(()=>{const s=document.querySelector('#chatScroll'),d=Object.getOwnPropertyDescriptor(Element.prototype,'scrollTop');const trace=window.__scrollTransitionTrace=[];const record=kind=>trace.push({kind,top:s.scrollTop,height:s.scrollHeight,client:s.clientHeight});record('before transition');s.addEventListener('scroll',()=>record('scroll event'));Object.defineProperty(s,'scrollTop',{configurable:true,get(){return d.get.call(this);},set(value){record('explicit write '+value);d.set.call(this,value);}});})()`);
   await evaluate(`__fixture.stream({token:'fixture',responseId:'scroll1',retry:{reason:'length',attempt:1,delayMs:0}});__fixture.stream({token:'fixture',start:true,responseId:'scroll2'});__fixture.stream({token:'fixture',responseId:'scroll2',text:'恢复后的正文\\n'.repeat(100)});`);await pause(150);
   assert.match(await evaluate(`${live}.querySelector('.retry-note').textContent`),/输出上限.*关闭思考.*1\/1.*额外计费/);
   const transitionTrace=await evaluate(`window.__scrollTransitionTrace`);
   assert.equal(await evaluate(bottom),false,'request regeneration must not force bottom: '+JSON.stringify(transitionTrace));
   await evaluate(`document.querySelector('#chatScroll').scrollTop=0;document.querySelector('#chatScroll').dispatchEvent(new Event('scroll'));__fixture.stream({token:'fixture',responseId:'scroll2',complete:true});__fixture.pending({content:'最终内容\\n'.repeat(100),toolStatus:{offered:[],requested:0,completed:0,failed:0}});__fixture.pending=null;`);
   await until(`!fixtureChat.isBusy()`);await pause(150);
   assert.equal(await evaluate(`document.querySelector('#chatScroll').scrollTop`),0,'completion preserves earlier-message reading position');
   await evaluate(`__fixture.pending=null`);await start();
   await evaluate(`__fixture.stream({token:'fixture',start:true,responseId:'follow-again'});document.querySelector('#chatScroll').scrollTop=document.querySelector('#chatScroll').scrollHeight;document.querySelector('#chatScroll').dispatchEvent(new Event('scroll'));__fixture.stream({token:'fixture',responseId:'follow-again',text:'继续输出\\n'.repeat(100)});`);await pause(150);
   assert.equal(await evaluate(bottom),true,'returning to bottom restores following');
   await evaluate(`__fixture.stream({token:'fixture',responseId:'follow-again',complete:true});__fixture.pending({content:'继续输出\\n'.repeat(100),toolStatus:{offered:[],requested:0,completed:0,failed:0}});__fixture.pending=null;`);await until(`!fixtureChat.isBusy()`);
   console.log('PASS streaming scroll: wheel navigation, nested reasoning, recovery notice, request transitions, completion and restored following');
   await evaluate(`window.idleTurn=new AgentTurn({mount:document.querySelector('#liveChatList')});void 0`);assert.equal(await evaluate(`getComputedStyle(idleTurn.dot).display`),'none');
  await evaluate(`fixtureChat.open('synthetic-history')`);assert.equal(await evaluate(`document.querySelectorAll('#liveChatList .agent-turn').length`),2);assert.equal(await evaluate(`document.querySelector('#liveChatList .agent-tool').dataset.open`),'false');assert.match(await evaluate(`document.querySelectorAll('#liveChatList .agent-turn')[1].textContent`),/原因和耗时未记录/);assert.match(await evaluate(`document.querySelector('#liveChatList .agent-answer').textContent`),/历史最终答复/);
  console.log('PASS real client renderer: derived folds, manual overrides, running CSS, failure collapse, stop amber, single turn, text safety, themes and reduced motion');
 }finally{ws?.close();if(child&&child.exitCode===null){spawn('taskkill',['/PID',String(child.pid),'/T','/F'],{stdio:'inherit'});} }
})().catch(e=>{console.error(e);process.exitCode=1;});
