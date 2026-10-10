import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,mkdir} from 'node:fs/promises';
import path from 'node:path';
import {createDesktopTaskFlow,PLAN_TOOLS} from '../src/desktop-task-flow.ts';
import {createDesktopTasks} from '../src/desktop-tasks.ts';
import {desktopModelSend} from '../src/desktop-model.ts';
import {startTestServer} from './server-fixture.ts';
const id='desktop-chat-00000000-0000-4000-8000-000000000082';
async function fixture(){const base=await mkdtemp(path.join(process.cwd(),'.verify-flow-')),home=path.join(base,'home'),root=path.join(base,'workspace');await mkdir(home);await mkdir(root);return {home,root,async close(){assert.equal(path.dirname(base),process.cwd());await rm(base,{recursive:true,force:true});}};}
const ctx={workspaceRoot:process.cwd()};
async function call(flow:Awaited<ReturnType<typeof createDesktopTaskFlow>>,name:string,args:Record<string,unknown>={}){return flow.tools.find(t=>t.name===name)!.execute(args,ctx);}
test('model goal creation, completion evidence, budget, repeated progress and paused recovery are durable',async()=>{
 const f=await fixture();try{
  const flow=await createDesktopTaskFlow(f.home,id,'Fix until verified',()=>{});await call(flow,'create_goal',{objective:'repair',criteria:'tests pass',maxRounds:3});assert.equal(flow.snapshot().task!.rounds,1);
  await call(flow,'update_goal',{status:'continue',summary:'fixed first issue'});assert.throws(()=>flow.gate('create_file'),/已报告/);await flow.endRound(false);await flow.beginRound();
  await call(flow,'update_goal',{status:'complete',summary:'done',evidence:'Executed test suite: 2 passed, 0 failed'});await flow.endRound(false);assert.equal(flow.snapshot().task!.status,'completed');assert.match(flow.snapshot().task!.reason,/模型/);
  const store=createDesktopTasks(f.home);await store.remove(id,flow.snapshot().revision);
  const next=await createDesktopTaskFlow(f.home,id,'/goal inspect',()=>{});assert.throws(()=>next.gate('create_file'),/先用/);await call(next,'create_goal',{objective:'inspect',criteria:'observed result'});await assert.rejects(call(next,'update_goal',{status:'complete',summary:'done'}),/证据/);
  await call(next,'update_goal',{status:'continue',summary:'same'});await next.endRound(false);await next.beginRound();await call(next,'update_goal',{status:'continue',summary:'same'});await next.endRound(false);assert.equal(next.snapshot().task!.status,'paused');assert.match(next.snapshot().task!.reason,/重复/);
  const resumed=await createDesktopTaskFlow(f.home,id,'continue?',()=>{});await assert.rejects(call(resumed,'create_goal',{objective:'reset budget',criteria:'x'}),/已有/);await assert.rejects(call(resumed,'update_goal',{status:'continue',summary:'x'}),/没有运行/);
 }finally{await f.close();}
});
test('plan blocks effects, edited approval is revision bound, failed round pauses, budget persists',async()=>{
 const f=await fixture();try{
  const flow=await createDesktopTaskFlow(f.home,id,'/plan implement',()=>{});assert.throws(()=>flow.gate('run_command'),/计划/);assert.throws(()=>flow.gate('mcp__remote__write'),/计划/);assert.throws(()=>flow.gate('create_goal'),/计划/);
  await call(flow,'create_plan',{objective:'implement',criteria:'test passes',plan:'1. inspect\n2. implement\n3. test'});const revisionFlow=await createDesktopTaskFlow(f.home,id,'/plan adjust the steps',()=>{});assert.equal(revisionFlow.planning(),true);await call(revisionFlow,'create_plan',{objective:'implement',criteria:'test passes',plan:'revised steps'});const old=revisionFlow.snapshot();
  const store=createDesktopTasks(f.home);const changed=await store.configure(id,{objective:'implement safely',maxRounds:2,plan:'revised plan'},old.revision);await assert.rejects(store.start(id,old.revision,true),/改变/);await assert.rejects(store.start(id,changed.revision),/未确认/);
  const approved=await createDesktopTaskFlow(f.home,id,'resume',()=>{});await approved.manualStart(changed.revision);await approved.beginRound();approved.gate('create_file');await approved.endRound(true);assert.equal(approved.snapshot().task!.status,'paused');assert.equal(approved.snapshot().task!.rounds,1);
  const crash=await store.start(id,approved.snapshot().revision,true);await store.beginRound(id,crash.revision);const reload=await createDesktopTaskFlow(f.home,id,'hello',()=>{});assert.equal(reload.snapshot().task!.status,'paused');await assert.rejects(reload.manualStart(reload.snapshot().revision),/轮数/);
 }finally{await f.close();}
});
test('actual model planning offers only read and plan tools even under full local permission',async()=>{
 const f=await fixture();let request=0;const server=await startTestServer(async(req,res)=>{let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);assert.ok(body.tools.every((t:any)=>PLAN_TOOLS.has(t.function.name)||['create_plan','get_goal'].includes(t.function.name)));assert.match(body.messages[0].content,/direct current human/);res.setHeader('content-type','application/json');res.end(JSON.stringify({choices:[{finish_reason:request++===0?'tool_calls':'stop',message:request===1?{role:'assistant',content:'',tool_calls:[{id:'plan',type:'function',function:{name:'create_plan',arguments:JSON.stringify({objective:'fix',criteria:'pass tests',plan:'Inspect then implement then verify'})}}]}:{role:'assistant',content:'Please approve the plan'}}]}));});
 try{await writeFile(path.join(f.root,'keep.txt'),'unchanged');const flow=await createDesktopTaskFlow(f.home,id,'/plan fix',()=>{}),config={baseUrl:`http://127.0.0.1:${server.port}/v1`,model:'fixture',apiKey:'test'};
 const result=await desktopModelSend(f.home,'/plan fix',config,{},config,id,{workspaceRoot:f.root,permission:'full',check(){},async approve(){throw Error('no effects during planning');}},undefined,{skills:[],tools:[],hostTools:flow.tools,planning:flow.planning(),beforeTool:flow.gate,taskGuidance:flow.guidance()});assert.equal(result.error,undefined);assert.equal(flow.snapshot().task!.planApproved,false);assert.equal(await readFile(path.join(f.root,'keep.txt'),'utf8'),'unchanged');assert.equal(request,2);
 }finally{await server.close();await f.close();}
});
