import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, readFile, writeFile, readdir, link, symlink, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { SessionStore } from '../src/session-store.ts';
import { desktopSessions } from '../src/desktop-sessions.ts';
import { renameSession, pinSession, deleteSession, exportSession } from '../src/desktop-session-management.ts';
const require = createRequire(import.meta.url), index = require('../desktop/chat-index.cjs'), fs = require('node:fs');
async function fixture() {
  const home = await mkdtemp(fileURLToPath(new URL('../.session-management-',import.meta.url))), id = 'desktop-chat-'+randomUUID();
  const store = new SessionStore({root:home,durability:'relaxed'});
  await store.appendMessage(id,{role:'user',content:'original user'});
  await store.appendMessage(id,{role:'assistant',content:'original reply'});
  await index.remember(home,{id,title:'original',identity:'PRIVATE_IDENTITY',workspaceRoot:null,failed:false});
  return {home,id,store};
}

test('rename and pin persist without touching transcript; malformed and legacy identities are refused',async()=>{
  const {home,id,store}=await fixture();
  try {
    const original=await readFile(store.pathFor(id),'utf8');
    assert.deepEqual(await renameSession(home,id,'  new title  '),{id,title:'new title'});
    assert.deepEqual(await pinSession(home,id,true),{id,pinned:true});
    assert.equal(index.readIndex(home).sessions[0].pinned,true);
    await pinSession(home,id,false); assert.equal(Object.hasOwn(index.find(home,id),'pinned'),false);
    assert.equal(await readFile(store.pathFor(id),'utf8'),original);
    for(const title of ['', '  ', 'bad\nname', 'x'.repeat(81), 5]) await assert.rejects(renameSession(home,id,title));
    for(const wrong of ['../escape','genes','desktop-chat-'+'-'.repeat(36),'chat-legacy','desktop-chat-'+randomUUID()]) {
      await assert.rejects(renameSession(home,wrong,'no')); await assert.rejects(pinSession(home,wrong,true));
      await assert.rejects(deleteSession(home,wrong)); await assert.rejects(exportSession(home,wrong));
    }
    await assert.rejects(pinSession(home,id,'true'));
    await store.withWriter(id,async()=>{ await assert.rejects(deleteSession(home,id),/占用/); });
    assert.equal(await readFile(store.pathFor(id),'utf8'),original);
  } finally { await rm(home,{recursive:true,force:true}); }
});

test('deletion physically removes history and index, and cannot resurface through legacy discovery',async()=>{
  const {home,id,store}=await fixture();
  try {
    const file=store.pathFor(id);
    assert.deepEqual(await deleteSession(home,id),{id,deleted:true,purgePending:false});
    await assert.rejects(readFile(file),{code:'ENOENT'});
    assert.equal(index.find(home,id),null);
    assert.ok(!(await desktopSessions(home)).ids.includes(id));
    assert.ok(!(await readdir(home)).some(name=>name.includes('.deleted')));
  } finally { await rm(home,{recursive:true,force:true}); }
});

test('corrupt and linked history are preserved; failed metadata commit restores the original file',async()=>{
  const {home,id,store}=await fixture();
  try {
    const file=store.pathFor(id), original=await readFile(file,'utf8');
    await writeFile(file,'{bad'); await assert.rejects(deleteSession(home,id));
    assert.equal(await readFile(file,'utf8'),'{bad'); assert.ok(index.find(home,id));
    await writeFile(file,original); const hard=join(home,'hardcopy'); await link(file,hard);
    await assert.rejects(deleteSession(home,id),/linked/); await assert.rejects(exportSession(home,id),/linked/); await rm(hard);
    const renameSync=fs.renameSync;
    fs.renameSync=(source:string,target:string)=>{ if(target===index.indexPath(home))throw Error('simulated index commit failure'); return renameSync(source,target); };
    try { await assert.rejects(deleteSession(home,id),/simulated/); } finally { fs.renameSync=renameSync; }
    assert.equal(await readFile(file,'utf8'),original); assert.ok(index.find(home,id));
    assert.ok(!(await readdir(home)).some(name=>name.endsWith('.deleted')));
    const target=join(home,'original.backup'); await writeFile(target,original); await rm(file);
    try { await symlink(target,file); }
    catch(error){ if((error as NodeJS.ErrnoException).code==='EPERM') return; throw error; }
    await assert.rejects(deleteSession(home,id),/linked/); assert.equal(await readFile(target,'utf8'),original);
  } finally { await rm(home,{recursive:true,force:true}); }
});

test('export contains every message beyond preview limit and tool evidence, never raw audit or provider metadata',async()=>{
  const {home,id,store}=await fixture();
  try {
    for(let i=0;i<202;i++) await store.appendMessage(id,{role:i%2?'assistant':'user',content:'message-'+i});
    await store.appendMessage(id,{role:'assistant',content:'',toolCalls:[{id:'call-1',name:'read_file',arguments:'{"path":"file.txt"}'}]});
    await store.appendMessage(id,{role:'tool',toolCallId:'call-1',content:'```\n<script>tool text</script>'},{isError:false});
    await store.appendAudit(id,{tool:'private',decision:'allowed',rule:'private',reason:'PRIVATE_AUDIT'});
    const exported=await exportSession(home,id,'json'), parsed=JSON.parse(exported.content);
    assert.equal(parsed.messages.length,206); assert.equal(parsed.messages[0].content,'original user');
    assert.equal(parsed.messages[203].content,'message-201'); assert.equal(parsed.messages[204].toolCalls[0].arguments,'{"path":"file.txt"}');
    assert.equal(parsed.messages[205].toolCallId,'call-1'); assert.equal(parsed.messages[205].isError,false);
    assert.ok(!exported.content.includes('PRIVATE_IDENTITY')); assert.ok(!exported.content.includes('PRIVATE_AUDIT'));
    const markdown=await exportSession(home,id); assert.equal(markdown.filename,id+'.md');
    assert.match(markdown.content,/original user/); assert.match(markdown.content,/message-201/); assert.match(markdown.content,/````text\n```\n<script>/);
    await assert.rejects(exportSession(home,id,'html'));
    await writeFile(store.pathFor(id),'x'.repeat(1024*1024+1));
    await assert.rejects(exportSession(home,id));
  } finally { await rm(home,{recursive:true,force:true}); }
});
