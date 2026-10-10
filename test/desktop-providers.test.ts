import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, link, unlink, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, resolve, sep } from 'node:path';
import { desktopModelSend } from '../src/desktop-model.ts';
import { DesktopProviders } from '../src/desktop-providers.ts';
import { startTestServer } from './server-fixture.ts';

test('per-model output limits persist, clear, isolate and reach HTTP requests',async()=>{
  const home=await mkdtemp(fileURLToPath(new URL('../.desktop-output-',import.meta.url)));
  const crypto={isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from(s),decryptString:(b:Buffer)=>b.toString()};const seen:number[]=[];
  const server=await startTestServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;seen.push(JSON.parse(raw).max_tokens);res.end(JSON.stringify({choices:[{finish_reason:'stop',message:{role:'assistant',content:'ok'}}]}));});
  const store=new DesktopProviders(home,crypto),provider={id:'one',name:'One',kind:'custom',protocol:'openai-chat',baseUrl:`http://127.0.0.1:${server.port}/v1`,models:['alpha','beta','__proto__'],apiKey:''};
  try{let state=await store.save({revision:'empty',provider});assert.equal((await store.resolve('one','alpha')).maxTokens,64000);assert.equal((await store.resolve('one','__proto__')).maxTokens,64000);
    for(const value of [0,-1,1.2,1048577,'32000',null,NaN])await assert.rejects(store.save({revision:state.revision,editingId:'one',provider:{...provider,outputLimits:{alpha:value}}}),/输出上限/);
    await assert.rejects(store.save({revision:state.revision,editingId:'one',provider:{...provider,outputLimits:{missing:4096}}}),/已添加/);
    const stale=state.revision;state=await store.save({revision:state.revision,editingId:'one',provider:{...provider,outputLimits:{alpha:16384}}});await assert.rejects(store.resolve('one','alpha',stale),/配置已变化/);
    const reopened=new DesktopProviders(home,crypto);assert.equal((await reopened.list()).providers[0]!.outputLimits!.alpha,16384);assert.equal((await reopened.resolve('one','beta')).maxTokens,64000);
    let config=await reopened.resolve('one','alpha');await desktopModelSend(home,'hi',config,{},config);
    state=await store.save({revision:state.revision,provider:{...provider,id:'two'}});assert.equal((await store.resolve('two','alpha')).maxTokens,64000);
    state=await store.save({revision:state.revision,editingId:'one',provider:{...provider,outputLimits:{}}});config=await store.resolve('one','alpha');await desktopModelSend(home,'again',config,{},config);assert.deepEqual(seen,[16384,64000]);
    await assert.rejects(desktopModelSend(home,'bad',config,{}, {...config,maxTokens:0}),/输出上限/);assert.equal(seen.length,2);
  }finally{await server.close();await rm(home,{recursive:true,force:true});}
});

test('thinking-off is opt-in per model, validated, revision-bound and reaches wire',async()=>{
 const home=await mkdtemp(fileURLToPath(new URL('../.thinking-',import.meta.url))),seen:any[]=[];const crypto={isEncryptionAvailable:()=>true,encryptString:(s:string)=>Buffer.from(s),decryptString:(b:Buffer)=>b.toString()};
 const server=await startTestServer(async(req,res)=>{let raw='';for await(const c of req)raw+=c;seen.push(JSON.parse(raw));res.end(JSON.stringify({choices:[{message:{content:'ok'},finish_reason:'stop'}]}));});
 const p={id:'a',name:'A',kind:'custom',protocol:'openai-chat',baseUrl:`http://127.0.0.1:${server.port}/v1`,models:['m','other'],apiKey:''};const store=new DesktopProviders(home,crypto);
 try{let s=await store.save({revision:'empty',provider:p});const old=s.revision;for(const bad of ['m',[true],['missing']])await assert.rejects(store.save({revision:s.revision,editingId:'a',provider:{...p,thinkingOff:bad}}));
 s=await store.save({revision:s.revision,editingId:'a',provider:{...p,thinkingOff:['m']}});await assert.rejects(store.resolve('a','m',old));assert.equal((await store.resolve('a','other')).thinkingDisabled,undefined);
 let c=await new DesktopProviders(home,crypto).resolve('a','m');await desktopModelSend(home,'hi',c,{},c);assert.deepEqual(seen[0].thinking,{type:'disabled'});
 s=await store.save({revision:s.revision,editingId:'a',provider:p});c=await store.resolve('a','m');await desktopModelSend(home,'hi',c,{},c);assert.equal(Object.hasOwn(seen[1],'thinking'),false);
 }finally{await server.close();await rm(home,{recursive:true,force:true});}
});

test('desktop providers: discovery, encrypted DTO, revisions, edits, links and upstream failures', async () => {
  const project = fileURLToPath(new URL('../', import.meta.url));
  const home = await mkdtemp(join(project, '.desktop-providers-test-'));
  assert.ok(resolve(home).startsWith(resolve(project) + sep));
  // Reversible test codec only; production passes Electron safeStorage.
  const crypto = { isEncryptionAvailable: () => true, encryptString: (v: string) => Buffer.from(v.split('').reverse().join('')), decryptString: (v: Buffer) => v.toString().split('').reverse().join('') };
  let mode = 'ok', requests = 0;
  const server = await startTestServer((req, res) => {
    requests++; assert.equal(req.url, '/v1/models'); assert.equal(req.headers.authorization, 'Bearer fixture-secret');
    if (mode === 'redirect') { res.writeHead(302, { Location: '/other' }); res.end(); }
    else if (mode === 'auth') { res.writeHead(401); res.end('fixture-secret'); }
    else if (mode === 'large') res.end('x'.repeat(262145));
    else res.end(JSON.stringify({ data: [{ id: 'one' }, { id: 'two' }, { id: 'one' }] }));
  });
  const store = new DesktopProviders(home, crypto), file = join(home, 'desktop-providers.json');
  const provider = { id: 'fixture', name: 'Fixture', kind: 'custom', protocol: 'openai-chat', baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: 'fixture-secret', models: ['one'] };
  try {
    assert.deepEqual((await store.list()).providers, []);
    await assert.rejects(store.save({ revision: 'empty', provider: { ...provider, apiKey: '密'.repeat(3000) } }), /密钥无效/);
    assert.deepEqual(await store.discover({ revision: 'empty', provider }), { models: ['one', 'two'] });
    let state = await store.save({ revision: 'empty', provider });
    assert.equal(state.providers[0]!.hasKey, true);
    assert.ok(!JSON.stringify(state).includes('secret'));
    assert.ok(!(await readFile(file, 'utf8')).includes('fixture-secret'));
    assert.equal((await store.resolve('fixture', 'one')).apiKey, 'fixture-secret');
    await assert.rejects(store.save({ revision: 'empty', provider }), /配置已变化/);
    await assert.rejects(store.save({ revision: state.revision, editingId: 'fixture', provider: { ...provider, apiKey: '', baseUrl: 'https://example.com/v1' } }), /重新输入密钥/);
    await assert.rejects(store.save({ revision: state.revision, provider: { ...provider, apiKey: '', models: [] } }), /已存在/);
    assert.deepEqual((await store.list()).providers[0]!.models, ['one']);
    const oldRevision = state.revision;
    state = await store.save({ revision: state.revision, editingId: 'fixture', provider: { ...provider, apiKey: '', name: 'Renamed' } });
    await assert.rejects(store.resolve('fixture', 'one', oldRevision), /配置已变化/);
    assert.equal((await store.resolve('fixture', 'one')).apiKey, 'fixture-secret');
    for (const m of ['redirect', 'auth', 'large']) {
      mode = m; const before = requests;
      await assert.rejects(store.discover({ revision: state.revision, editingId: 'fixture', provider }), e => e instanceof Error && !e.message.includes('fixture-secret'));
      assert.equal(requests, before + 1);
    }
    const unavailable = new DesktopProviders(home, { ...crypto, isEncryptionAvailable: () => false });
    await assert.rejects(unavailable.save({ revision: state.revision, editingId: 'fixture', provider }), /拒绝明文/);
    await link(file, join(home, 'alias'));
    await assert.rejects(store.list(), /不安全/);
    await unlink(join(home, 'alias'));
    await writeFile(file + '.lock', 'fixture', { flag: 'wx' });
    await assert.rejects(store.delete({ revision: state.revision, id: 'fixture' }), /配置正在修改/);
    await unlink(file + '.lock');
    state = await store.delete({ revision: state.revision, id: 'fixture' });
    assert.deepEqual(state.providers, []);
    await assert.rejects(store.resolve('fixture', 'one'));
  } finally { await server.close(); await rm(home, { recursive: true, force: true }); }
});
