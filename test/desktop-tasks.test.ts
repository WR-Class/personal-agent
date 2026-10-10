import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,writeFile,readFile,link} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDesktopTasks} from '../src/desktop-tasks.ts';
const prefix=fileURLToPath(new URL('../.verify-tasks-',import.meta.url));
const id='desktop-chat-00000000-0000-4000-8000-000000000081';
test('legacy caps migrate durably on read without panel edits or state changes',async()=>{
 const home=await mkdtemp(prefix);try{
  const s=createDesktopTasks(home);let x=await s.get(id);x=await s.configure(id,{objective:'keep work',maxRounds:3,criteria:'verified output',plan:'keep plan'},x.revision);
  const p=path.join(home,'desktop-tasks',id+'.json');
  for(const status of ['ready','running','paused','review','completed'] as const){
   const legacy={...x.task!,status,rounds:3,checkpoint:'existing progress',reason:'existing reason',planApproved:true};
   await writeFile(p,JSON.stringify({version:1,task:legacy}));
   const migrated=await s.get(id);assert.deepEqual(migrated.task,{...legacy,maxRounds:0});
   assert.deepEqual(JSON.parse(await readFile(p,'utf8')),{version:2,task:migrated.task});
   assert.deepEqual(await createDesktopTasks(home).get(id),migrated);
   await assert.rejects(s.start(id,x.revision),/改变/);
   if(status==='paused'){let next=await s.start(id,migrated.revision);next=await s.beginRound(id,next.revision);assert.equal(next.task!.rounds,4);}
  }
  const before=await readFile(p,'utf8');await writeFile(p,before.replace('"version":2','"version":99'));await assert.rejects(s.get(id));assert.equal(await readFile(p,'utf8'),before.replace('"version":2','"version":99'));
 }finally{assert.ok(home.startsWith(prefix));await rm(home,{recursive:true,force:true});}
});
test('zero round cap keeps progressing and cancellation still pauses',async()=>{
 const home=await mkdtemp(prefix);try{const s=createDesktopTasks(home);let x=await s.get(id);x=await s.configure(id,{objective:'finish',maxRounds:0},x.revision);x=await s.start(id,x.revision);
 for(let i=0;i<21;i++){x=await s.beginRound(id,x.revision);x=await s.checkpoint(id,{status:'continue',summary:'progress '+i},x.revision);assert.equal(x.task!.status,'running');}assert.equal(x.task!.rounds,21);assert.equal((await s.pause(id,'user stop')).task!.status,'paused');
 }finally{await rm(home,{recursive:true,force:true});}
});
test('durable task consumes budget before attempts, rejects stale updates, pauses on crash and never self-completes',async()=>{
 const home=await mkdtemp(prefix);try{
 const s=createDesktopTasks(home),other=createDesktopTasks(home);let x=await s.get(id);assert.equal(x.task,null);
 x=await s.configure(id,{objective:'build and verify',maxRounds:2},x.revision);const initial=x;
 x=await s.start(id,x.revision);await assert.rejects(other.start(id,initial.revision),/改变/);
 x=await s.beginRound(id,x.revision);assert.equal(x.task!.rounds,1);
 x=await other.recover(id);assert.equal(x.task!.status,'paused');assert.equal(x.task!.rounds,1);
 await assert.rejects(s.checkpoint(id,{status:'continue',summary:'late'},x.revision));
 x=await s.start(id,x.revision);x=await s.beginRound(id,x.revision);x=await s.checkpoint(id,{status:'continue',summary:'progress'},x.revision);assert.equal(x.task!.status,'paused');await assert.rejects(s.start(id,x.revision));
 x=await s.configure(id,{objective:'revised by human',maxRounds:3},x.revision);assert.equal(x.task!.rounds,2);assert.equal(x.task!.planApproved,false);
 x=await s.start(id,x.revision);x=await s.beginRound(id,x.revision);x=await s.checkpoint(id,{status:'review',summary:'model says ready'},x.revision);assert.equal(x.task!.status,'review');assert.notEqual(x.task!.status,'completed');x=await s.finish(id,x.revision);assert.equal(x.task!.status,'completed');assert.equal((await s.pause(id,'stop')).task!.status,'completed');
 }finally{assert.ok(home.startsWith(prefix));await rm(home,{recursive:true,force:true});}
});
test('task storage refuses invalid IDs, hardlinks and corruption without clobbering',async()=>{
 const home=await mkdtemp(prefix);try{
 const s=createDesktopTasks(home);await assert.rejects(s.get('../escape'));let x=await s.get(id);x=await s.configure(id,{objective:'inspect',maxRounds:1},x.revision);const p=path.join(home,'desktop-tasks',id+'.json'),alias=path.join(home,'alias');await link(p,alias);await assert.rejects(s.get(id));await rm(alias);await writeFile(p,'corrupt');await assert.rejects(s.configure(id,{objective:'new',maxRounds:2},x.revision));assert.equal(await readFile(p,'utf8'),'corrupt');
 }finally{assert.ok(home.startsWith(prefix));await rm(home,{recursive:true,force:true});}
});
