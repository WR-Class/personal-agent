import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { desktopModelSend } from '../src/desktop-model.ts';
import { SessionStore } from '../src/session-store.ts';
import { createDesktopTaskFlow } from '../src/desktop-task-flow.ts';
import { startTestServer } from './server-fixture.ts';

test('real artifact survives stop and same-session continuation verifies it without replay', async () => {
  const base = await mkdtemp(path.join(process.cwd(), '.representative-task-'));
  const home = path.join(base, 'home'), workspaceRoot = path.join(base, 'workspace');
  await mkdir(home); await mkdir(workspaceRoot);
  const id = 'desktop-chat-' + randomUUID(), controller = new AbortController();
  let requests = 0, prompts = 0;
  const call = (name: string, args: object, callId: string) => ({id:callId,type:'function',function:{name,arguments:JSON.stringify(args)}});
  const server = await startTestServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw); requests++;
    let message: object;
    if (requests === 1) {
      message = {role:'assistant',content:'',tool_calls:[call('create_file',{path:'result.txt',content:'draft'},'create')]};
    } else if (requests === 2) {
      message = {role:'assistant',content:'',tool_calls:[call('patch_file',{path:'result.txt',oldText:'draft',newText:'verified artifact'},'patch')]};
    } else if (requests === 3) {
      controller.abort(); res.end('{}'); return;
    } else if (requests === 4) {
      const results = body.messages.filter((m: any) => m.role === 'tool');
      assert.equal(results.filter((m: any) => m.tool_call_id === 'create').length, 1);
      assert.equal(results.filter((m: any) => m.tool_call_id === 'patch').length, 1);
      message = {role:'assistant',content:'',tool_calls:[call('run_command',{command:`"${process.execPath}" -e "const fs=require('node:fs');if(fs.readFileSync('result.txt','utf8')!=='verified artifact')process.exit(1);console.log('ARTIFACT_VALIDATED')"`},'validate')]};
    } else {
      assert.equal(requests, 5);
      const validation = body.messages.find((m: any) => m.tool_call_id === 'validate');
      assert.match(validation.content, /ARTIFACT_VALIDATED/);
      message = {role:'assistant',content:'Artifact verified after continuation'};
    }
    res.end(JSON.stringify({choices:[{message,finish_reason:'tool_calls' in message?'tool_calls':'stop'}]}));
  });
  const config = {baseUrl:`http://127.0.0.1:${server.port}/v1`,model:'fixture',apiKey:'synthetic'};
  const options = {workspaceRoot,permission:'write' as const,check(){},async approve(){prompts++;return true;}};
  try {
    const stopped = await desktopModelSend(home,'Create then revise the artifact',config,{},config,id,options,controller.signal);
    assert.match(stopped.error!, /请求已停止/);
    assert.equal(await readFile(path.join(workspaceRoot,'result.txt'),'utf8'), 'verified artifact');
    const continued = await desktopModelSend(home,'Inspect and validate existing artifact; do not replay edits',config,{},config,id,options);
    assert.equal(continued.error, undefined); assert.equal(continued.id, id);
    assert.equal(await readFile(path.join(workspaceRoot,'result.txt'),'utf8'), 'verified artifact');
    const history = await new SessionStore({root:home}).history(id);
    const names = history.flatMap(m => m.toolCalls?.map(t => t.name) ?? []);
    assert.deepEqual(names, ['create_file','patch_file','run_command']);
    assert.equal(prompts, 1, 'only the validation command asks in desktop write permission');
    assert.equal(requests, 5);
  } finally {
    await server.close(); assert.equal(path.dirname(base),process.cwd()); await rm(base,{recursive:true,force:true});
  }
});

test('paused long task reloads and requires manual resume before model creates final artifact', async () => {
  const base = await mkdtemp(path.join(process.cwd(), '.representative-goal-'));
  const home = path.join(base,'home'), workspaceRoot = path.join(base,'workspace');
  await mkdir(home); await mkdir(workspaceRoot);
  const id = 'desktop-chat-' + randomUUID();
  const initial = await createDesktopTaskFlow(home,id,'/goal produce final artifact',()=>{});
  const context = {workspaceRoot};
  await initial.tools.find(t=>t.name==='create_goal')!.execute({objective:'produce final artifact',criteria:'final.txt contains accepted',maxRounds:3},context);
  await initial.pause('operator stopped');
  const resumed = await createDesktopTaskFlow(home,id,'continue',()=>{});
  assert.equal(resumed.snapshot().task!.status,'paused');
  await assert.rejects(resumed.tools.find(t=>t.name==='update_goal')!.execute({status:'continue',summary:'auto resume'},context), /没有运行/);
  await resumed.manualStart(resumed.snapshot().revision); await resumed.beginRound();
  let requests = 0;
  const server = await startTestServer(async(req,res)=>{
    let raw=''; for await(const chunk of req)raw+=chunk;
    const body=JSON.parse(raw);requests++;
    const tool=(name:string,args:object)=>({id:'goal-'+requests,type:'function',function:{name,arguments:JSON.stringify(args)}});
    let message:object;
    if(requests===1)message={role:'assistant',content:'',tool_calls:[tool('create_file',{path:'final.txt',content:'accepted'})]};
    else if(requests===2){
      assert.equal(await readFile(path.join(workspaceRoot,'final.txt'),'utf8'),'accepted');
      assert.ok(body.messages.some((m:any)=>m.role==='tool'));
      message={role:'assistant',content:'',tool_calls:[tool('update_goal',{status:'complete',summary:'artifact created',evidence:'final.txt contains accepted'})]};
    }else{assert.equal(requests,3);message={role:'assistant',content:'Ready for acceptance'};}
    res.end(JSON.stringify({choices:[{message,finish_reason:'tool_calls' in message?'tool_calls':'stop'}]}));
  });
  const config={baseUrl:`http://127.0.0.1:${server.port}/v1`,model:'fixture',apiKey:'synthetic'};
  try{
    const result=await desktopModelSend(home,'Resume approved task',config,{},config,id,{workspaceRoot,permission:'write',check(){},async approve(){return true;}},undefined,{skills:[],tools:[],hostTools:resumed.tools,beforeTool:resumed.gate,planning:resumed.planning(),taskGuidance:resumed.guidance()});
    assert.equal(result.error,undefined);
    await resumed.endRound(!!result.error||!!result.toolStatus?.failed);
    const reloaded=await createDesktopTaskFlow(home,id,'inspect',()=>{});
    assert.equal(reloaded.snapshot().task!.status,'completed');
    assert.equal(reloaded.snapshot().task!.rounds,2);
    assert.equal(await readFile(path.join(workspaceRoot,'final.txt'),'utf8'),'accepted');
    const history=await new SessionStore({root:home}).history(id);
    assert.equal(history.flatMap(m=>m.toolCalls??[]).filter(t=>t.name==='create_file').length,1);
  }finally{await server.close();assert.equal(path.dirname(base),process.cwd());await rm(base,{recursive:true,force:true});}
});
