import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm, readFile, appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { desktopProvider, desktopModelSend } from '../src/desktop-model.ts';
import { SessionStore } from '../src/session-store.ts';
import { startTestServer } from './server-fixture.ts';

test('transient model retry does not replay successful tools and backoff cancels',async()=>{
 const home=await mkdtemp(fileURLToPath(new URL('../.desktop-retry-',import.meta.url)));let calls=0,executed=0;const retries:number[]=[];
 const server=await startTestServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;calls++;if(calls===2){res.writeHead(503);res.end('{}');return;}res.end(JSON.stringify({choices:[{finish_reason:calls===1?'tool_calls':'stop',message:calls===1?{content:'check',tool_calls:[{id:'one',type:'function',function:{name:'get_goal',arguments:'{}'}}]}:{content:'done'}}]}));});
 const config={baseUrl:`http://127.0.0.1:${server.port}/v1`,model:'m',apiKey:''},opts={workspaceRoot:home,remoteOnly:true,permission:'read' as const,check(){},async approve(){return false;}};
 try{const r=await desktopModelSend(home,'go',config,{},config,undefined,opts,undefined,{skills:[],tools:[],onStream:e=>{if(e.retry)retries.push(e.retry.attempt);},hostTools:[{name:'get_goal',description:'test',readOnly:true,parameters:{type:'object',properties:{}},async execute(){executed++;return {content:'ok'};}}]});assert.equal(r.error,undefined);assert.equal(calls,3);assert.equal(executed,1);assert.deepEqual(retries,[1]);
 const original=globalThis.fetch,controller=new AbortController();let tries=0;
 try{globalThis.fetch=async()=>{tries++;return new Response('{}',{status:429});};const r=await desktopModelSend(home,'cancel',config,{},config,undefined,opts,controller.signal,{skills:[],tools:[],onStream:e=>{if(e.retry)controller.abort();}});assert.match(r.error!,/请求已停止/);assert.equal(tries,1);
 tries=0;const exhausted=await desktopModelSend(home,'retry cap',config,{},config,undefined,opts);assert.equal(tries,3);assert.match(exhausted.error!,/自动重试 2 次/);
 }finally{globalThis.fetch=original;}
 }finally{await server.close();await rm(home,{recursive:true,force:true});}
});

test('desktop recovery retains failed turns, pairs interrupted tools without replay, and refuses corruption', async () => {
  const home = await mkdtemp(fileURLToPath(new URL('../.desktop-recovery-', import.meta.url)));
  const id = 'desktop-chat-' + randomUUID(), store = new SessionStore({root: home});
  let fail = true, requests = 0, prompt: any[] = [];
  const server = await startTestServer(async(req,res) => {
    let text=''; for await(const chunk of req) text+=chunk;
    prompt=JSON.parse(text).messages; requests++;
    if(fail) { res.writeHead(503); res.end('{}'); return; }
    res.end(JSON.stringify({model:'fixture',choices:[{message:{role:'assistant',content:'continued'},finish_reason:'stop'}]}));
  });
  const config={baseUrl:`http://127.0.0.1:${server.port}/v1`,model:'fixture',apiKey:'synthetic'};
  try {
    await assert.rejects(desktopModelSend(home,'failed user turn',config,{},config,id));
    fail=false;
    assert.equal((await desktopModelSend(home,'continue',config,{},config,id)).id,id);
    assert.deepEqual(prompt.filter(m=>m.role==='user').map(m=>m.content),['failed user turn','continue']);
    await store.appendMessage(id,{role:'assistant',content:'',toolCalls:[{id:'lost',name:'create_file',arguments:'{"path":"never.txt","content":"never"}'},{id:'saved',name:'read_file',arguments:'{"path":"x"}'}]});
    await store.append(id,{v:1,ignorable:true,at:new Date().toISOString(),kind:'tool/result',callId:'saved',name:'read_file',content:'ACTUAL SAVED RESULT',isError:false});
    const result=await desktopModelSend(home,'inspect before continuing',config,{},config,id);
    assert.equal(result.recoveredTools,2);
    assert.match(prompt.find(m=>m.tool_call_id==='lost').content,/outcome unknown.*NOT replayed/);
    assert.equal(prompt.find(m=>m.tool_call_id==='saved').content,'ACTUAL SAVED RESULT');
    assert.ok(!(await readdir(home)).includes('never.txt'));
    assert.equal((await store.pendingTools(id)).length,0);
    assert.equal((await desktopModelSend(home,'again',config,{},config,id)).recoveredTools,0);
    const file=join(home,id+'.jsonl'); await appendFile(file,'{torn');
    const before=await readFile(file,'utf8'), count=requests;
    await assert.rejects(desktopModelSend(home,'do not overwrite',config,{},config,id));
    assert.equal(await readFile(file,'utf8'),before); assert.equal(requests,count);
    // Narrowed from "one .jsonl in home": the swarm's two stores now live here too, and
    // the claim this line is actually making is that the torn session log was refused
    // rather than repaired into a second session log.
    assert.deepEqual((await readdir(home)).filter(n=>n.startsWith('desktop-chat-')&&n.endsWith('.jsonl')),[id+'.jsonl']);
    // ⚠️ Positive evidence for the wiring, produced by the real `desktopModelSend` path:
    // before `desktop-model.ts` passed the two stores, this directory held one .jsonl and
    // the library never saw a desktop round.
    const written=await readdir(home);
    assert.ok(written.includes('cycles.jsonl'),'桌面端每轮都要落 PDRI 周期账本');
    assert.ok(written.includes('genes.outcomes.jsonl'),'桌面端每轮都要落 outcome 行');
  } finally { await server.close(); await rm(home,{recursive:true,force:true}); }
});

test('desktop timeout reports safe elapsed and actual transport phase without retry',async()=>{
  const home=await mkdtemp(fileURLToPath(new URL('../.desktop-timeout-',import.meta.url)));
  const original=globalThis.fetch,config={baseUrl:'https://fixture.invalid/v1',model:'fixture',apiKey:'fixture-secret'};let calls=0;
  const opts={workspaceRoot:home,permission:'read' as const,remoteOnly:true,check(){},async approve(){return false;}};
  try{
    globalThis.fetch=async()=>{calls++;throw new DOMException('secret-upstream-details','TimeoutError');};
    const head=await desktopModelSend(home,'hello',config,{},config,undefined,opts);
    assert.match(head.error!,/等待模型服务响应头/);assert.match(head.error!,/本轮耗时 [\d.]+ 秒/);assert.match(head.error!,/调用尝试 1 次/);assert.match(head.error!,/不设整轮时限，单次模型请求期限 600 秒/);assert.match(head.error!,/网关可能独立重试/);assert.ok(!head.error!.includes('secret-upstream-details'));assert.equal(calls,1);
    globalThis.fetch=async()=>{calls++;return new Response(new ReadableStream({start(c){c.error(new DOMException('private-body','TimeoutError'));}}));};
    const body=await desktopModelSend(home,'hello',config,{},config,undefined,opts);
    assert.match(body.error!,/接收模型服务响应正文/);assert.equal(calls,2);assert.ok(!body.error!.includes('private-body'));
    globalThis.fetch=async()=>{throw new Error('model response exceeds the 33554432-byte limit');};
    assert.match((await desktopModelSend(home,'size',config,{},config,undefined,opts)).error!,/32 MiB 安全上限（不是 token 上限）/);
    globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.error(new TypeError('terminated'));}}));
    assert.match((await desktopModelSend(home,'closed',config,{},config,undefined,opts)).error!,/连接在接收正文时中断/);
    for(const [name,expected] of [['FirstDataTimeoutError',/首个响应数据超过180秒/],['StreamIdleTimeoutError',/连续90秒没有新数据/]] as const){globalThis.fetch=async()=>new Response(new ReadableStream({start(c){c.error(new DOMException('private',name));}}));assert.match((await desktopModelSend(home,'timeout',config,{},config,undefined,opts)).error!,expected);}
  }finally{globalThis.fetch=original;await rm(home,{recursive:true,force:true});}
});

test('desktop SSE previews text but length cutoff never executes assembled tools',async()=>{
  const home=await mkdtemp(fileURLToPath(new URL('../.desktop-sse-',import.meta.url)));let executed=0,requests=0;const preview:string[]=[];
  const server=await startTestServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;assert.equal(JSON.parse(raw).stream,true);requests++;res.setHeader('Content-Type','text/event-stream');
    res.write('data: '+JSON.stringify({choices:[{delta:{content:'HTML预览',tool_calls:[{index:0,id:'cut',type:'function',function:{name:'get_goal',arguments:'{}'}}]}}]})+'\n\n');
    res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:'length'}]})+'\n\ndata: [DONE]\n\n');});
  const config={baseUrl:`http://127.0.0.1:${server.port}/v1`,model:'fixture',apiKey:'synthetic'};
  try{const r=await desktopModelSend(home,'html',config,{},config,undefined,{workspaceRoot:home,remoteOnly:true,permission:'read',check(){},async approve(){return false;}},undefined,{skills:[],tools:[],onStream:e=>{if(e.text)preview.push(e.text);},hostTools:[{name:'get_goal',description:'fixture',readOnly:true,parameters:{type:'object',properties:{}},async execute(){executed++;return {content:'never'};}}]});assert.deepEqual(preview,['HTML预览','HTML预览']);assert.match(r.error!,/输出长度限制/);assert.equal(executed,0,'neither truncated attempt may execute tools');assert.equal(requests,2,'one bounded regeneration, then stop on repeated truncation');assert.match(r.error!,/输出截断后关闭思考重新生成 1\/1 次/);assert.deepEqual((await new SessionStore({root:home}).history(r.id)).map(m=>m.role),['user']);}
  finally{await server.close();await rm(home,{recursive:true,force:true});}
});

test('desktop truncated responses never execute tools and stop after one regeneration',async()=>{
  const home=await mkdtemp(fileURLToPath(new URL('../.desktop-truncated-',import.meta.url)));let requests=0,executed=0;
  const server=await startTestServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;const body=JSON.parse(raw);assert.equal(body.max_tokens,64000);requests++;res.end(JSON.stringify({choices:[{finish_reason:'length',message:{role:'assistant',content:'unfinished',tool_calls:[{id:'cut',type:'function',function:{name:'get_goal',arguments:'{}'}}]}}]}));});
  const config={baseUrl:`http://127.0.0.1:${server.port}/v1`,model:'fixture',apiKey:'synthetic'};
  try{const result=await desktopModelSend(home,'inspect',config,{},config,undefined,{workspaceRoot:home,permission:'read',remoteOnly:true,check(){},async approve(){return false;}},undefined,{skills:[],tools:[],hostTools:[{name:'get_goal',description:'fixture',readOnly:true,parameters:{type:'object',properties:{}},async execute(){executed++;return {content:'never'};}}]});assert.match(result.error!,/输出长度限制/);assert.equal(requests,2,'one regeneration only, even when the second response is also truncated');assert.equal(executed,0,'complete-looking tools from either truncated response must never execute');assert.equal(result.toolStatus?.completed,0);const history=await new SessionStore({root:home}).history(result.id);assert.deepEqual(history.map(m=>m.role),['user']);}
  finally{await server.close();await rm(home,{recursive:true,force:true});}
});

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
    assert.equal(body.max_tokens,64000,'desktop must not reintroduce its legacy 2048 output cap');
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

test('mixed length recovery discards truncated tools, preserves completed tools and resets each request budget', async () => {
  const home=await mkdtemp(fileURLToPath(new URL('../.desktop-mixed-recovery-',import.meta.url)));
  const bodies:any[]=[],executed:string[]=[],progress=new Map<string,number>(),reasons:string[]=[];
  const call=(id:string,args:string)=>({index:0,id,type:'function',function:{name:'get_goal',arguments:args}});
  const server=await startTestServer(async(req,res)=>{
    let raw='';for await(const chunk of req)raw+=chunk;bodies.push(JSON.parse(raw));
    const step=bodies.length;
    res.setHeader('Content-Type','text/event-stream');
    const delta=step===1?{reasoning_content:'检查',tool_calls:[call('saved','{"label":"saved"}')]}:
      step===2?{reasoning_content:'思'.repeat(100),content:'partial',tool_calls:[call('discarded','{"label":')]}:
      step===3?{reasoning_content:'恢复',tool_calls:[call('recovered','{"label":"recovered"}')]}:
      {reasoning_content:'完成',content:'done'};
    res.write('data: '+JSON.stringify({choices:[{delta}]})+'\n\n');
    res.end('data: '+JSON.stringify({choices:[{delta:{},finish_reason:step===2?'length':step===4?'stop':'tool_calls'}]})+'\n\ndata: [DONE]\n\n');
  });
  const config={baseUrl:`http://127.0.0.1:${server.port}/v1`,model:'fixture',apiKey:'synthetic',maxTokens:256};
  try{
    const result=await desktopModelSend(home,'recover safely',config,{},config,undefined,
      {workspaceRoot:home,remoteOnly:true,permission:'read',check(){},async approve(){return false;}},undefined,
      {skills:[],tools:[],onStream:e=>{if(e.progress)progress.set(e.responseId,e.progress.reasoningChars);if(e.retry)reasons.push(e.retry.reason||'transport');},
       hostTools:[{name:'get_goal',description:'fixture',readOnly:true,parameters:{type:'object',properties:{label:{type:'string'}},required:['label']},async execute(args){executed.push(String(args.label));return {content:'saved result '+args.label};}}]});
    assert.equal(result.error,undefined);assert.equal(result.content,'done');assert.equal(bodies.length,4);
    assert.deepEqual(executed,['saved','recovered'],'earlier tools execute once; truncated tool never executes');
    assert.deepEqual(bodies.map(b=>b.max_tokens),[256,256,256,256],'each request gets the full configured output budget');
    assert.deepEqual([...progress.values()],[2,100,2,2],'reasoning counters reset rather than accumulate between requests');
    assert.deepEqual(bodies[2].messages,bodies[1].messages,'recovery regenerates only the rejected request');
    assert.equal(bodies[0].thinking,undefined);assert.equal(bodies[1].thinking,undefined);
    assert.deepEqual(bodies[2].thinking,{type:'disabled'});assert.deepEqual(bodies[3].thinking,{type:'disabled'});
    assert.deepEqual(reasons,['length']);
    const history=await new SessionStore({root:home}).history(result.id);
    assert.deepEqual(history.flatMap(m=>(m.toolCalls||[]).map(c=>c.id)),['saved','recovered']);
    assert.equal(history.filter(m=>m.role==='user').length,1,'recovery does not restart runtime.send');
    assert.ok(!history.some(m=>m.content==='partial'),'truncated preview is not persisted as an answer');
  }finally{await server.close();await rm(home,{recursive:true,force:true});}
});

test('cancellation at length recovery notification prevents the additional request',async()=>{
  const home=await mkdtemp(fileURLToPath(new URL('../.desktop-recovery-cancel-',import.meta.url)));
  const controller=new AbortController();let requests=0;
  const server=await startTestServer(async(req,res)=>{
    for await(const _chunk of req){}requests++;
    res.end(JSON.stringify({choices:[{finish_reason:'length',message:{content:'partial',reasoning_content:'thinking'}}]}));
  });
  const config={baseUrl:`http://127.0.0.1:${server.port}/v1`,model:'fixture',apiKey:'synthetic'};
  try{
    const result=await desktopModelSend(home,'cancel recovery',config,{},config,undefined,
      {workspaceRoot:home,remoteOnly:true,permission:'read',check(){},async approve(){return false;}},controller.signal,
      {skills:[],tools:[],onStream:e=>{if(e.retry?.reason==='length')controller.abort();}});
    assert.match(result.error!,/请求已停止/);assert.equal(requests,1);
    assert.deepEqual((await new SessionStore({root:home}).history(result.id)).map(m=>m.role),['user']);
  }finally{await server.close();await rm(home,{recursive:true,force:true});}
});

test('desktop pure-reasoning cutoff resumes once with thinking disabled', async () => {
  const home = await mkdtemp(fileURLToPath(new URL('../.desktop-resume-', import.meta.url)));
  const bodies: Record<string, unknown>[] = [];
  const server = await startTestServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    bodies.push(JSON.parse(raw)); res.setHeader('Content-Type', 'text/event-stream');
    if (bodies.length === 1) {
      // Whole ceiling spent on reasoning: no body, no tool arguments — the resumable shape.
      res.write('data: ' + JSON.stringify({ choices: [{ delta: { reasoning_content: '想'.repeat(500) } }] }) + '\n\n');
      res.end('data: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'length' }] }) + '\n\ndata: [DONE]\n\n');
      return;
    }
    res.end('data: ' + JSON.stringify({ choices: [{ delta: { content: '恢复后的回答' } }] }) + '\n\ndata: ' + JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] }) + '\n\ndata: [DONE]\n\n');
  });
  const config = { baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'fixture', apiKey: 'synthetic' };
  const extensions = { skills: [], tools: [], hostTools: [{ name: 'get_goal', description: 'fixture', readOnly: true, parameters: { type: 'object' as const, properties: {} }, async execute() { return { content: 'never' }; } }] };
  try {
    const result = await desktopModelSend(home, 'resume', config, {}, config, undefined, { workspaceRoot: home, remoteOnly: true, permission: 'read', check() {}, async approve() { return false; } }, undefined, extensions);
    assert.equal(bodies.length, 2, 'exactly one resume');
    assert.equal(bodies[0]!.thinking, undefined, 'first attempt keeps the configured thinking mode');
    assert.deepEqual(bodies[1]!.thinking, { type: 'disabled' }, 'resume must ask for no thinking');
    assert.equal(result.error, undefined);
    assert.equal(result.content, '恢复后的回答');
  } finally { await server.close(); await rm(home, { recursive: true, force: true }); }
});

test('desktop account notice is reported as an account problem, never as an answer', async () => {
  const home = await mkdtemp(fileURLToPath(new URL('../.desktop-account-', import.meta.url)));
  const server = await startTestServer(async (_req, res) => {
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '您的Token额度已用完！如需继续使用，可前往订购页面选择套餐。' }, finish_reason: 'stop' }] }));
  });
  const config = { baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'fixture', apiKey: 'synthetic' };
  const extensions = { skills: [], tools: [], hostTools: [{ name: 'get_goal', description: 'fixture', readOnly: true, parameters: { type: 'object' as const, properties: {} }, async execute() { return { content: 'never' }; } }] };
  try {
    const result = await desktopModelSend(home, 'quota', config, {}, config, undefined, { workspaceRoot: home, remoteOnly: true, permission: 'read', check() {}, async approve() { return false; } }, undefined, extensions);
    assert.match(result.error!, /账户\/额度提示/);
  } finally { await server.close(); await rm(home, { recursive: true, force: true }); }
});
