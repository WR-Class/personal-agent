import {lstat,mkdir,open,rename,unlink} from 'node:fs/promises';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {assertSafeStateDirectory,canonicalPath,configuredProtectedRoots} from './security-config.ts';
import {withSessionLease} from './session-lease.ts';
export class DesktopTaskError extends Error {}
export type DesktopTask={objective:string;status:'ready'|'running'|'paused'|'review'|'completed';maxRounds:number;rounds:number;checkpoint:string;reason:string;criteria?:string;plan?:string;planApproved?:boolean};
function fail(message='任务状态无效；原记录保留'):never{throw new DesktopTaskError(message);}
function text(v:unknown,max:number,empty=false):string{if(typeof v!=='string'||(!empty&&!v.trim())||Buffer.byteLength(v)>max||/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(v))fail();return v;}
function task(v:unknown):DesktopTask{
 if(!v||typeof v!=='object'||Array.isArray(v)||Object.keys(v).some(k=>!['objective','status','maxRounds','rounds','checkpoint','reason','criteria','plan','planApproved'].includes(k)))fail();const t=v as DesktopTask;
 text(t.objective,4000);text(t.checkpoint,2000,true);text(t.reason,500,true);
  if(t.criteria!==undefined)text(t.criteria,2000,true);if(t.plan!==undefined)text(t.plan,6000,true);if(t.planApproved!==undefined&&typeof t.planApproved!=='boolean')fail();
 if(!['ready','running','paused','review','completed'].includes(t.status)||!Number.isSafeInteger(t.maxRounds)||t.maxRounds<0||t.maxRounds>20||!Number.isSafeInteger(t.rounds)||t.rounds<0||(t.maxRounds>0&&t.rounds>t.maxRounds))fail();return t;
}
const snapshot=(value:DesktopTask|null)=>({revision:createHash('sha256').update(JSON.stringify(value)).digest('hex'),task:value});
/** State only: host owns execution, consent, interruption and identity. No persisted task auto-starts. */
export function createDesktopTasks(home:string){
 function file(id:string){if(!/^desktop-chat-[a-f0-9-]{36}$/.test(id))fail();const root=assertSafeStateDirectory(home,{protectedRoots:configuredProtectedRoots(process.env)});if(root!==path.resolve(home))fail();return path.join(root,'desktop-tasks',id+'.json');}
 async function safe(p:string){if(canonicalPath(p)!==p)fail();for(let c=p;;c=path.dirname(c)){try{const s=await lstat(c);if(s.isSymbolicLink()||(c===p&&(!s.isFile()||s.nlink!==1||s.size>16384)))fail();}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}if(path.dirname(c)===c)break;}}
 async function load(id:string):Promise<{version:number;task:DesktopTask}|null>{
  const p=file(id);await safe(p);let h;try{h=await open(p,'r');}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return null;throw e;}
  try{const stat=await h.stat();if(!stat.isFile()||stat.nlink!==1||stat.size>16384)fail();const b=Buffer.alloc(16385);let n=0,count;do{count=(await h.read(b,n,b.length-n,null)).bytesRead;n+=count;}while(count&&n<b.length);if(n>16384)fail();await safe(p);const after=await lstat(p);if(after.ino!==stat.ino||after.dev!==stat.dev||n!==stat.size)fail();const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(b.subarray(0,n)));if(!raw||![1,2].includes(raw.version)||Object.keys(raw).some(k=>!['version','task'].includes(k)))fail();return {version:raw.version,task:task(raw.task)};}finally{await h.close();}
 }
 async function mutate(id:string,revision:unknown,change:(value:DesktopTask|null)=>DesktopTask|null){
  const p=file(id);await safe(p);await mkdir(path.dirname(p),{recursive:true});return withSessionLease(p,async()=>{
   const record=await load(id),legacy=record?.version===1;
   // Operator-requested migration: remove all previously stored caps, without resuming tasks.
   const previous=record?(legacy?{...record.task,maxRounds:0}:record.task):null;
   if(revision!==undefined&&revision!==snapshot(previous).revision)fail('任务已改变，请刷新后重试');const next=change(previous);if(next===previous&&!legacy)return snapshot(previous);if(!next){await safe(p);await unlink(p);return snapshot(null);}task(next);
   const serialized=JSON.stringify({version:2,task:next});if(Buffer.byteLength(serialized)>16384)fail('任务记录过大，请缩短目标或计划');
    const tmp=p+'.'+randomUUID()+'.tmp',h=await open(tmp,'wx',0o600);try{await h.writeFile(serialized);await h.sync();}finally{await h.close();}
   try{await safe(p);await rename(tmp,p);}finally{try{await unlink(tmp);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}return snapshot(next);
  });
 }
 function expected(revision:unknown){if(typeof revision!=='string'||! /^[a-f0-9]{64}$/.test(revision))fail('请刷新任务后重试');return revision;}
 return{
  async get(id:string){const record=await load(id);return record?.version===1?mutate(id,undefined,t=>t):snapshot(record?.task??null);},
  async configure(id:string,input:{objective:string;maxRounds:number;criteria?:string;plan?:string},revision:unknown){return mutate(id,expected(revision),t=>{
   if(!input||typeof input!=='object'||Object.keys(input).some(k=>!['objective','maxRounds','criteria','plan'].includes(k)))fail();
   if(t&&(t.status==='running'||t.status==='completed'))fail('运行中或已完成任务不能修改');
   return task({objective:input.objective,maxRounds:input.maxRounds,rounds:t?.rounds??0,status:t?'paused':'ready',checkpoint:t?.checkpoint??'',reason:'',criteria:input.criteria??t?.criteria??'',plan:input.plan??t?.plan??'',planApproved:false});
  });},
  async remove(id:string,revision:unknown){return mutate(id,expected(revision),t=>{if(t?.status==='running')fail('请先停止当前运行');return null;});},
   async start(id:string,revision:unknown,approvePlan=false){return mutate(id,expected(revision),t=>{if(!t||!['ready','paused','review'].includes(t.status)||(t.maxRounds>0&&t.rounds>=t.maxRounds))fail('任务不能启动或轮数已用完');if(t.plan&&!t.planApproved&&!approvePlan)fail('计划尚未确认');return {...t,status:'running',reason:'',planApproved:t.plan?true:t.planApproved};});},
  async beginRound(id:string,revision:unknown){return mutate(id,expected(revision),t=>{if(!t||t.status!=='running'||(t.maxRounds>0&&t.rounds>=t.maxRounds))fail('未获继续授权或轮数已用完');return {...t,rounds:t.rounds+1};});},
  async checkpoint(id:string,input:{status:'continue'|'needs_input'|'review'|'complete';summary:string;evidence?:string},revision:unknown){return mutate(id,expected(revision),t=>{
   if(!t||t.status!=='running'||t.rounds<1||!input||Object.keys(input).some(k=>!['status','summary','evidence'].includes(k))||!['continue','needs_input','review','complete'].includes(input.status))fail('任务已停止或进度无效');text(input.summary,2000);
   if(input.status==='complete')text(input.evidence,1500);
    const stalled=input.status==='continue'&&input.summary.trim()===t.checkpoint.trim();
    const status=input.status==='complete'?'completed':input.status==='review'?'review':input.status==='needs_input'||(t.maxRounds>0&&t.rounds>=t.maxRounds)||stalled?'paused':'running';
   return {...t,checkpoint:input.status==='complete'?text(input.summary+'\n证据：'+input.evidence,2000):input.summary,status,reason:input.status==='complete'?'模型基于证据报告完成（非独立验收）':stalled?'进度重复；暂停避免空转':input.status==='needs_input'?'等待用户输入':input.status==='review'?'模型报告待验收；不是验证通过':(t.maxRounds>0&&t.rounds>=t.maxRounds)?'达到已授权轮数':''};
  });},
  async pause(id:string,reason:string){text(reason,500);return mutate(id,undefined,t=>!t||t.status!=='running'?t:{...t,status:'paused',reason});},
  async recover(id:string){return mutate(id,undefined,t=>!t||t.status!=='running'?t:{...t,status:'paused',reason:'上次执行中断；需手动恢复，不重跑旧工具'});},
  async finish(id:string,revision:unknown){return mutate(id,expected(revision),t=>{if(!t||t.status==='running'||t.status==='completed')fail('请先停止并检查任务结果');return {...t,status:'completed',reason:'用户手动确认完成；并非自动测试判定'};});},
 };
}
