import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, symlink, link } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createDesktopTools } from '../src/desktop-tools.ts';
import type { DesktopToolOptions } from '../src/desktop-tools.ts';
import { desktopModelSend } from '../src/desktop-model.ts';
import { SessionStore } from '../src/session-store.ts';
import { startTestServer } from './server-fixture.ts';
import { buildToolEnvironment } from '../src/tool-environment.ts';
import { findJob, stopJobs } from '../src/background-jobs.ts';

const project = fileURLToPath(new URL('../', import.meta.url));
async function fixture() {
  const root = await mkdtemp(join(project, '.desktop-tools-test-'));
  const workspaceRoot = join(root, 'workspace'), home = join(root, 'home');
  await mkdir(workspaceRoot); await mkdir(home);
  return { root, workspaceRoot, home, close: () => rm(root, { recursive: true, force: true }) };
}
function harness(workspaceRoot: string, overrides: Partial<DesktopToolOptions> = {}) {
  const options: DesktopToolOptions = { workspaceRoot, permission: 'write', check() {}, approve: async () => true, ...overrides };
  const { tools, rules } = createDesktopTools(options, { store: new SessionStore({ root: join(workspaceRoot, '..', 'home') }), id: 'fixture-session' });
  const execute = (name: string, args: object, extra: object = {}) => tools.execute({ id: randomUUID(), name, arguments: JSON.stringify(args) }, { workspaceRoot, rules, ...extra });
  return { tools, execute };
}

test('desktop tools: empty file succeeds; upstream failure reports successful listing without leaking response', async () => {
  const f = await fixture(); let step = 0, rejectFinal = true;
  await writeFile(join(f.workspaceRoot, 'empty.txt'), '');
  const server = await startTestServer(async (req, res) => {
    let text = ''; for await (const c of req) text += c;
    const body = JSON.parse(text); step++;
    if (step === 1) {
      assert.match(body.messages[0].content, /do not guess/);
      res.end(JSON.stringify({ model: 'fixture', choices: [{ message: { role: 'assistant', content: '', tool_calls: [
        { id: 'list', type: 'function', function: { name: 'list_directory', arguments: '{"path":"."}' } },
        { id: 'empty', type: 'function', function: { name: 'read_file', arguments: '{"path":"empty.txt"}' } },
      ] }, finish_reason: 'tool_calls' }] }));
    } else {
      assert.equal(body.messages.find((m: any) => m.tool_call_id === 'empty').content, '');
      if (rejectFinal) { res.writeHead(400); res.end('{"error":"do-not-leak-fixture-key"}'); }
      else res.end(JSON.stringify({ model: 'fixture', choices: [{ message: { role: 'assistant', content: '目录中有一个空文件 empty.txt。' }, finish_reason: 'stop' }] }));
    }
  });
  try {
    const config = { baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'fixture', apiKey: 'fixture-key' };
    const result = await desktopModelSend(f.home, 'list files', config, {}, config, undefined,
      { workspaceRoot: f.workspaceRoot, permission: 'read', check() {}, approve: async () => false });
    assert.match(result.error!, /HTTP 400/);
    assert.match(result.error!, /目录读取已成功：列出 1 个文件/);
    assert.equal(result.toolStatus?.completed, 2); assert.equal(result.toolStatus?.failed, 0);
    assert.ok(!result.error!.includes('fixture-key'));
    assert.equal(step, 2);
    step = 0; rejectFinal = false;
    const success = await desktopModelSend(f.home, 'list files', config, {}, config, undefined,
      { workspaceRoot: f.workspaceRoot, permission: 'read', check() {}, approve: async () => false });
    assert.equal(success.error, undefined); assert.match(success.content, /一个空文件/);
    assert.equal(success.toolStatus?.completed, 2); assert.equal(step, 2);
  } finally { await server.close(); await f.close(); }
});

test('desktop tools: read-only shares core inspection and job output but omits writes and shell', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspaceRoot, 'note.txt'), 'hello');
    const h = harness(f.workspaceRoot, { permission: 'read', approve: async () => { throw Error('must never ask'); } });
    assert.deepEqual(h.tools.definitions().map(t => t.name), ['read_file', 'inspect_file', 'job_output', 'obs_recall', 'list_directory']);
    assert.equal((await h.execute('read_file', { path: 'note.txt' })).content, 'hello');
    assert.equal((await h.execute('create_file', { path: 'new.txt', content: 'bad' })).isError, true);
    assert.deepEqual(await readdir(f.workspaceRoot), ['note.txt']);
  } finally { await f.close(); }
});

test('desktop tools: workspace files autoapprove but shell cannot inherit caller preApproval/grants', async () => {
  const f = await fixture(); let prompts = 0;
  try {
    const h = harness(f.workspaceRoot, { approve: async () => { prompts++; return true; } });
    const extra = { preApproved: true, grants: [{ tool: 'create_file', argumentsJson: '{"path":"a.txt","content":"one"}', expiresAt: Date.now() + 50000 }] };
    assert.ok(!(await h.execute('create_file', { path: 'a.txt', content: 'one' }, extra)).isError);
    assert.ok(!(await h.execute('edit_file', { path: 'a.txt', content: 'two' }, extra)).isError);
    assert.ok(!(await h.execute('patch_file', { path: 'a.txt', oldText: 'two', newText: 'three' }, extra)).isError);
    assert.equal(prompts, 0); assert.equal(await readFile(join(f.workspaceRoot, 'a.txt'), 'utf8'), 'three');
    const denied = harness(f.workspaceRoot, { approve: async () => { prompts++; return false; } });
    assert.equal((await denied.execute('run_command', { command: 'echo blocked' }, extra)).isError, true);
    assert.equal(prompts, 1);
    assert.equal(await readFile(join(f.workspaceRoot, 'a.txt'), 'utf8'), 'three');
  } finally { await f.close(); }
});

test('desktop tools: cancellation during approval and revoked roots prevent writes', async () => {
  const f = await fixture();
  try {
    const controller = new AbortController();
    const cancelled = harness(f.workspaceRoot, { approve: async (_prompt, signal) => {
      assert.equal(signal, controller.signal); controller.abort(); return true;
    } });
    assert.equal((await cancelled.execute('run_command', { command: 'echo blocked' }, { signal: controller.signal })).isError, true);
    let valid = true;
    const revoked = harness(f.workspaceRoot, { check() { if (!valid) throw Error('revoked'); }, approve: async () => { valid = false; return true; } });
    assert.equal((await revoked.execute('run_command', { command: 'echo blocked' })).isError, true);
    assert.equal((await revoked.execute('read_file', { path: 'revoke.txt' })).isError, true);
    const already = new AbortController(); already.abort();
    assert.throws(() => harness(f.workspaceRoot, { signal: already.signal }));
    assert.deepEqual(await readdir(f.workspaceRoot), []);
  } finally { await f.close(); }
});

test('desktop tools: sensitive paths, trust roots, unrestricted flags, hardlinks and directory links are denied', async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.root, 'outside.txt'), 'private');
    await writeFile(join(f.workspaceRoot, '.env'), 'secret');
    await writeFile(join(f.workspaceRoot, 'visible.txt'), 'ok');
    await link(join(f.root, 'outside.txt'), join(f.workspaceRoot, 'hardlink.txt'));
    await mkdir(join(f.workspaceRoot, 'normal'));
    await symlink(join(f.workspaceRoot, 'normal'), join(f.workspaceRoot, 'linked'), 'junction');
    const h = harness(f.workspaceRoot);
    const extra = { readableRoots: [f.root], unrestrictedWrites: true, unrestrictedReads: true };
    assert.equal((await h.execute('read_file', { path: '../outside.txt' }, extra)).isError, true);
    assert.equal((await h.execute('create_file', { path: '../escape.txt', content: 'bad' }, extra)).isError, true);
    assert.equal((await h.execute('read_file', { path: '.env' })).isError, true);
    assert.equal((await h.execute('read_file', { path: 'hardlink.txt' })).isError, true);
    assert.equal((await h.execute('edit_file', { path: 'hardlink.txt', content: 'bad' })).isError, true);
    assert.equal((await h.execute('list_directory', { path: 'linked' })).isError, true);
    const listing = JSON.parse((await h.execute('list_directory', { path: '.' })).content);
    assert.deepEqual(listing.entries.map((e: { name: string }) => e.name).sort(), ['normal', 'visible.txt']);
  } finally { await f.close(); }
});

test('desktop full tier permits outside reads and writes without prompts but preserves protected and link boundaries', async () => {
  const f = await fixture(); let prompts = 0;
  try {
    const h = harness(f.workspaceRoot, {permission:'full', approve: async () => {prompts++; return false;}});
    for (const [name, args] of [
      ['create_file', {path:'../outside.txt',content:'one'}],
      ['edit_file', {path:'../outside.txt',content:'two'}],
      ['patch_file', {path:'../outside.txt',oldText:'two',newText:'three'}],
    ] as const) assert.notEqual((await h.execute(name, args)).isError, true);
    assert.equal(prompts, 0); assert.equal(await readFile(join(f.root,'outside.txt'),'utf8'), 'three');
    assert.equal((await h.execute('read_file', {path:'../outside.txt'})).content, 'three');
    assert.notEqual((await h.execute('list_directory', {path:'..'})).isError, true);
    assert.equal((await h.execute('read_file', {path:'../outside.txt'}, {protectedRoots:[f.root]})).isError, true);
    for (const target of ['../.env', '../home/trust.json']) {
      assert.equal((await h.execute('create_file', {path:target,content:'bad'}, {protectedRoots:[f.home]})).isError, true);
    }
    await symlink(f.root, join(f.workspaceRoot,'linked'), 'junction');
    assert.equal((await h.execute('create_file', {path:'linked/bad.txt',content:'bad'})).isError, true);
    await link(join(f.root,'outside.txt'), join(f.root,'alias.txt'));
    assert.equal((await h.execute('edit_file', {path:'../alias.txt',content:'bad'})).isError, true);
    assert.equal(await readFile(join(f.root,'outside.txt'),'utf8'), 'three');
  } finally { await f.close(); }
});

test('desktop core commands use rebuilt environment, require workspace approval and isolate jobs by session', {timeout:15000}, async () => {
  const f = await fixture(); let prompts = 0;
  const id = 'owner-' + randomUUID(), store = new SessionStore({root:f.home});
  const environment = buildToolEnvironment({workspaceRoot:f.workspaceRoot, agentHome:f.home});
  const create = (owner: string) => {
    const c = createDesktopTools({workspaceRoot:f.workspaceRoot,permission:'write',check(){},approve:async()=>{prompts++;return true;}},{store,id:owner});
    return (name: string, args: object) => c.tools.execute({id:randomUUID(),name,arguments:JSON.stringify(args)},
      {workspaceRoot:f.workspaceRoot,rules:c.rules,toolEnvironment:environment,jobOwner:'forged-owner'});
  };
  try {
    const execute = create(id), other = create('other-' + id);
    assert.match((await execute('run_command',{command:'echo CORE_COMMAND_OK'})).content,/CORE_COMMAND_OK/);
    assert.equal(prompts,1);
    const result = await execute('run_command',{command:'echo CORE_BACKGROUND_OK',run_in_background:true});
    const jobId = /started background job (\S+)/.exec(result.content)![1]!;
    assert.equal(findJob(jobId),undefined); assert.equal(findJob(jobId,'forged-owner'),undefined);
    assert.ok(findJob(jobId,id));
    const deadline = Date.now() + 5000;
    while (findJob(jobId,id)!.finishedAt === null && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
    assert.notEqual(findJob(jobId,id)!.finishedAt, null, 'background command finishes within fixture deadline');
    assert.match((await execute('job_output',{job_id:jobId})).content,/CORE_BACKGROUND_OK/);
    assert.equal((await other('job_output',{job_id:jobId})).isError,true);
    assert.equal((await other('job_kill',{job_id:jobId})).isError,true);
    assert.match((await execute('job_kill',{job_id:jobId})).content,/finished/);
    assert.equal(prompts,2,'owner output and kill need no repeated command approval');
  } finally { await stopJobs(id); await f.close(); }
});

test('desktop tools: directory scans are capped without recursion', async () => {
  const f = await fixture();
  try {
    await Promise.all(Array.from({ length: 505 }, (_, i) => writeFile(join(f.workspaceRoot, `entry-${i}`), '')));
    const h = harness(f.workspaceRoot);
    const listing = JSON.parse((await h.execute('list_directory', { path: '.' })).content);
    assert.equal(listing.entries.length, 500); assert.equal(listing.truncated, true);
  } finally { await f.close(); }
});

test('desktop model: multistep tools, config ignored, trust root confined, transcript correlates real results', async () => {
  const f = await fixture(); let step = 0, approvals = 0;
  await writeFile(join(f.root, 'outside.txt'), 'private');
  // Runtime reads trust.json, but the desktop tools strip its extra readable roots.
  await writeFile(join(f.home, 'trust.json'), JSON.stringify({ version: 1, readableRoots: [{ root: f.root, grantedAt: new Date().toISOString() }] }));
  await writeFile(join(f.home, 'config.json'), JSON.stringify({ tier: 'full-access', rules: [{ tool: '*', decision: 'allow' }] }));
  const server = await startTestServer(async (req, res) => {
    let text = ''; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); step++;
    const names = body.tools.map((t: { function: { name: string } }) => t.function.name);
    for (const name of ['read_file', 'inspect_file', 'list_directory', 'run_command', 'job_output', 'job_kill', 'update_task_state', 'obs_recall', 'create_file', 'edit_file', 'patch_file', 'delete_file', 'rename_file', 'batch_files']) assert.ok(names.includes(name), name);
    const calls = step === 1 ? [{ id: 'outside', type: 'function', function: { name: 'read_file', arguments: JSON.stringify({ path: '../outside.txt' }) } }]
      : step === 2 ? [{ id: 'create', type: 'function', function: { name: 'create_file', arguments: JSON.stringify({ path: 'answer.txt', content: 'saved' }) } }] : [];
    if (step === 3) assert.ok(body.messages.some((m: { role: string; content: string }) => m.role === 'tool' && m.content === 'created answer.txt'));
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ model: 'fixture', choices: [{ message: { role: 'assistant', content: calls.length ? null : 'Done', ...(calls.length ? { tool_calls: calls } : {}) }, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 3, completion_tokens: 2 } }));
  });
  const selected = { baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'fixture', apiKey: 'fixture-key' };
  try {
    const result = await desktopModelSend(f.home, 'create an answer', selected, {}, selected, undefined,
      { workspaceRoot: f.workspaceRoot, permission: 'write', check() {}, approve: async () => { approvals++; return true; } });
    assert.equal(result.error, undefined); assert.equal(result.content, 'Done'); assert.equal(step, 3); assert.equal(approvals, 0);
    assert.deepEqual(result.transcript?.map(e => [e.kind, e.callId, e.name]), [['call', 'outside', 'read_file'], ['result', 'outside', 'read_file'], ['call', 'create', 'create_file'], ['result', 'create', 'create_file']]);
    assert.equal(result.transcript?.[1]?.kind === 'result' && result.transcript[1].isError, true);
    assert.equal(await readFile(join(f.workspaceRoot, 'answer.txt'), 'utf8'), 'saved');
    assert.ok(!JSON.stringify(result).includes('fixture-key'));
  } finally { await server.close(); await f.close(); }
});

test('desktop full runtime records explicit tier and cannot alter its state home', async () => {
  const f=await fixture(); let step=0;
  const server=await startTestServer(async(req,res)=>{
    for await(const _ of req){} step++;
    const calls=step===1 ? [
      {id:'allowed',type:'function',function:{name:'create_file',arguments:JSON.stringify({path:'../answer.txt',content:'yes'})}},
      {id:'protected',type:'function',function:{name:'create_file',arguments:JSON.stringify({path:'../home/trust.json',content:'bad'})}},
    ] : [];
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:calls.length?null:'Done',...(calls.length?{tool_calls:calls}:{})},finish_reason:calls.length?'tool_calls':'stop'}]}));
  });
  const selected={baseUrl:`http://127.0.0.1:${server.port}/v1`,model:'fixture',apiKey:'fixture'};
  try {
    const result=await desktopModelSend(f.home,'write',selected,{},selected,undefined,{workspaceRoot:f.workspaceRoot,permission:'full',check(){},approve:async()=>{throw Error('must not ask');}});
    assert.equal(result.error,undefined); assert.equal(await readFile(join(f.root,'answer.txt'),'utf8'),'yes');
    assert.ok(!(await readdir(f.home)).includes('trust.json'));
    const events=await new SessionStore({root:f.home}).read(result.id);
    assert.ok(events.some(e=>e.kind==='audit' && e.rule==='tier:full-access' && e.decision==='allowed'));
    assert.equal(result.toolStatus?.completed,1); assert.equal(result.toolStatus?.failed,1);
  } finally {await server.close();await f.close();}
});

test('desktop model: eighth-argument signal cancels text-only sends without issuing HTTP', async () => {
  const f = await fixture();
  const controller = new AbortController(); controller.abort();
  const selected = { baseUrl: 'http://127.0.0.1:1/v1', model: 'fixture', apiKey: 'fixture-key' };
  try {
    await assert.rejects(desktopModelSend(f.home, 'hello', selected, {}, selected, undefined, undefined, controller.signal), { name: 'AbortError' });
    assert.deepEqual(await readdir(f.home), []);
  } finally { await f.close(); }
});

test('desktop stop disconnects in-flight HTTP with or without tools and preserves completed reads', {timeout:15000}, async () => {
  for (const withTools of [false, true]) {
    const f = await fixture(); let requests = 0;
    let arrived!: () => void, disconnected!: () => void;
    const ready = new Promise<void>(r => {arrived=r;}), closed = new Promise<void>(r => {disconnected=r;});
    let held: import('node:http').ServerResponse | undefined;
    const server = await startTestServer(async (req,res) => {
      for await (const _ of req) { /* drain */ } requests++;
      if (withTools && requests === 1) {
        res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:[{id:'listed',type:'function',function:{name:'list_directory',arguments:'{"path":"."}'}}]},finish_reason:'tool_calls'}]}));
      } else { held=res; res.once('close', disconnected); arrived(); }
    });
    const selected={baseUrl:`http://127.0.0.1:${server.port}/v1`,model:'fixture',apiKey:'fixture'};
    const controller=new AbortController(), other=new AbortController();
    try {
      const sending=desktopModelSend(f.home,'hello',selected,{},selected,undefined,
        withTools ? {workspaceRoot:f.workspaceRoot,permission:'write',check(){},approve:async()=>{throw Error('unexpected');},signal:other.signal} : undefined,controller.signal);
      // Observe rejection immediately so cancellation cannot create an unhandled promise.
      const settled=sending.then(value=>({value}),error=>({error}));
      await ready; controller.abort(); await closed;
      const outcome=await settled;
      if (withTools) { assert.ok('value' in outcome); assert.match(outcome.value!.error!, /请求已停止/); assert.equal(outcome.value!.toolStatus?.completed,1); }
      else assert.ok('error' in outcome);
      assert.equal(requests,withTools?2:1); assert.deepEqual(await readdir(f.workspaceRoot),[]);
    } finally { held?.destroy(); await server.close(); await f.close(); }
  }
});

test('desktop stop during shell approval executes neither command nor subsequent tool', {timeout:10000}, async () => {
  const f=await fixture(); let requests=0, approveStarted!:()=>void;
  const ready=new Promise<void>(r=>{approveStarted=r;}); const controller=new AbortController();
  const server=await startTestServer(async(req,res)=>{
    for await(const _ of req){} requests++;
    res.end(JSON.stringify({choices:[{message:{role:'assistant',content:null,tool_calls:['first','second'].map(id=>({id,type:'function',function:{name:'run_command',arguments:JSON.stringify({command:'echo bad > '+id+'.txt'})}}))},finish_reason:'tool_calls'}]}));
  });
  const selected={baseUrl:`http://127.0.0.1:${server.port}/v1`,model:'fixture',apiKey:'fixture'};
  try {
    const sending=desktopModelSend(f.home,'write',selected,{},selected,undefined,{workspaceRoot:f.workspaceRoot,permission:'write',check(){},approve:async(_prompt,signal)=>{
      approveStarted(); await new Promise<void>(resolve=>signal!.addEventListener('abort',()=>resolve(),{once:true})); return true;
    }},controller.signal);
    await ready; controller.abort(); const result=await sending;
    assert.match(result.error!,/请求已停止/); assert.equal(requests,1); assert.deepEqual(await readdir(f.workspaceRoot),[]);
  } finally {await server.close(); await f.close();}
});

test('desktop model: failure after real write returns actual transcript and keeps durable logs', async () => {
  const f = await fixture(); let step = 0;
  const server = await startTestServer(async (req, res) => {
    for await (const _ of req) { /* drain request */ }
    step++; res.setHeader('Content-Type', 'application/json');
    if (step > 1) { res.writeHead(400); res.end('{"error":"fixture"}'); return; }
    res.end(JSON.stringify({ model: 'fixture', choices: [{ message: { role: 'assistant', content: null, tool_calls: [{ id: 'written', type: 'function', function: { name: 'create_file', arguments: '{"path":"kept.txt","content":"real"}' } }] }, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  const selected = { baseUrl: `http://127.0.0.1:${server.port}/v1`, model: 'fixture', apiKey: 'fixture-key' };
  try {
    const result = await desktopModelSend(f.home, 'create a file', selected, {}, selected, undefined,
      { workspaceRoot: f.workspaceRoot, permission: 'write', check() {}, approve: async () => true });
    assert.ok(result.error); assert.equal(result.content, '');
    assert.equal(await readFile(join(f.workspaceRoot, 'kept.txt'), 'utf8'), 'real');
    assert.equal(result.transcript?.[1]?.kind === 'result' && result.transcript[1].isError, false);
    const history = await new SessionStore({ root: f.home }).history(result.id);
    assert.ok(history.some(m => m.role === 'tool' && m.content === 'created kept.txt'));
  } finally { await server.close(); await f.close(); }
});
