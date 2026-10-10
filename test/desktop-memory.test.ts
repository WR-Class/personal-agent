import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,rm,writeFile,readFile,link} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createDesktopMemory} from '../src/desktop-memory.ts';
import {desktopModelSend} from '../src/desktop-model.ts';
import {startTestServer} from './server-fixture.ts';
const prefix=fileURLToPath(new URL('../.verify-memory-',import.meta.url));
test('explicit memory persists with CAS, scopes, disable/delete, and rejects credentials/corrupt hardlinks',async()=>{
 const root=await mkdtemp(prefix);const home=path.join(root,'home'),one=path.join(root,'one'),two=path.join(root,'two');await mkdir(home);await mkdir(one);await mkdir(two);
 try{
  const s=createDesktopMemory(home),other=createDesktopMemory(home);const first=await s.list();let current=await s.save({text:'Prefer concise answers',scope:'global'},first.revision);
  await assert.rejects(other.save({text:'stale',scope:'global'},first.revision),/已改变/);
  assert.equal((await other.list()).entries.length,1);
  current=await s.save({text:'Workspace sentinel',scope:'workspace',workspaceRoot:one},current.revision);
  assert.match(await s.prompt(one),/Workspace sentinel/);assert.doesNotMatch(await s.prompt(two),/Workspace sentinel/);assert.match(await s.prompt(),/concise/);
  current=await s.toggle(current.entries[0]!.id,false,current.revision);assert.doesNotMatch(await s.prompt(),/concise/);
  await assert.rejects(s.save({text:'Authorization: Bearer secret123',scope:'global'},current.revision),/凭据/);
  await assert.rejects(s.save({text:'a'.repeat(2001),scope:'global'},current.revision));assert.equal((await s.list()).revision,current.revision);
  current=await s.remove(current.entries[1]!.id,current.revision);assert.equal(await s.prompt(one),'');
  await s.clear(current.revision);assert.equal((await s.list()).entries.length,0);
  const file=path.join(home,'desktop-memory.json');await link(file,path.join(root,'alias'));await assert.rejects(s.list());await rm(path.join(root,'alias'));
  await writeFile(file,'broken');await assert.rejects(s.clear(current.revision));assert.equal(await readFile(file,'utf8'),'broken');
 }finally{assert.ok(root.startsWith(prefix));await rm(root,{recursive:true,force:true});}
});
test('actual desktop requests use explicit memory across sessions; disabled entries stop new injection',async()=>{
 const root=await mkdtemp(prefix);const home=path.join(root,'home');await mkdir(home);const requests:any[]=[];
 const server=await startTestServer(async(req,res)=>{let raw='';for await(const part of req)raw+=part;requests.push(JSON.parse(raw));res.end(JSON.stringify({model:'fixture',choices:[{message:{role:'assistant',content:'ok'},finish_reason:'stop'}]}));});
 const config={baseUrl:`http://127.0.0.1:${server.port}/v1`,model:'fixture',apiKey:'synthetic'};
 try{
  const s=createDesktopMemory(home);let state=await s.save({text:'MEMORY_SENTINEL prefer Chinese',scope:'global'},(await s.list()).revision);
  for(let i=0;i<2;i++){const r=await desktopModelSend(home,'hello',config,{},config);assert.equal(r.content,'ok');assert.ok(requests.at(-1).messages.some((m:any)=>m.role==='system'&&m.content.includes('MEMORY_SENTINEL')));}
  await s.toggle(state.entries[0]!.id,false,state.revision);await desktopModelSend(home,'hello',config,{},config);assert.ok(!requests.at(-1).messages.some((m:any)=>m.content.includes('MEMORY_SENTINEL')));
 }finally{await server.close();assert.ok(root.startsWith(prefix));await rm(root,{recursive:true,force:true});}
});
