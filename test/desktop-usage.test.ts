import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { createOpenAIChatAdapter } from '../src/openai-adapter.ts';
import { validateResponse } from '../src/response-validation.ts';
import { SessionStore, migrateEvent, type SessionEvent } from '../src/session-store.ts';
import { desktopUsageSummary } from '../src/desktop-usage.ts';
import { desktopHistory } from '../src/desktop-sessions.ts';
import { desktopModelSend } from '../src/desktop-model.ts';
import { startTestServer } from './server-fixture.ts';

function adapter(usage?: unknown) {
  return createOpenAIChatAdapter({ baseUrl: 'https://fixture.invalid/v1', model: 'fixture', apiKey: 'test',
    fetchImpl: async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }], ...(usage === undefined ? {} : { usage }) })) });
}
const request = { messages: [{ role: 'user' as const, content: 'test' }] };
const message = (role: 'user'|'assistant'|'tool'): SessionEvent => ({ v:1, kind:'message', at:'now', message:{role,content:'fixture'} });
const usage = (value: {inputTokens:number; outputTokens:number; reported?:boolean; cachedInputTokens?:number; durationMs?:number}): SessionEvent => ({v:1,kind:'usage',at:'now',usage:value});

test('adapter distinguishes explicit zero, absent counts and validated cache fields; measures request wall time', async () => {
  const result = await adapter({prompt_tokens:1000,completion_tokens:100,prompt_tokens_details:{cached_tokens:900}}).chat(request);
  assert.equal(result.usage.reported,true); assert.equal(result.usage.cachedInputTokens,900);
  assert.ok(result.usage.durationMs! > 0 && Number.isFinite(result.usage.durationMs));
  assert.equal((await adapter({prompt_tokens:100,completion_tokens:10,prompt_cache_hit_tokens:60}).chat(request)).usage.cachedInputTokens,60);
  for (const counts of [undefined, {}, {prompt_tokens:10}, {completion_tokens:10}, {prompt_tokens:null,completion_tokens:10}]) {
    assert.equal((await adapter(counts).chat(request)).usage.reported,false);
  }
  const zero = (await adapter({prompt_tokens:0,completion_tokens:0}).chat(request)).usage;
  assert.equal(zero.reported,true); assert.equal(zero.cachedInputTokens,undefined);
  for (const cached_tokens of [-1,101,1.5,'50']) await assert.rejects(adapter({prompt_tokens:100,completion_tokens:10,prompt_tokens_details:{cached_tokens}}).chat(request));
  await assert.rejects(adapter({prompt_tokens:-1,completion_tokens:10}).chat(request));
  for (const bad of [{reported:'yes'},{durationMs:-1},{durationMs:Infinity},{cachedInputTokens:101}]) {
    assert.throws(()=>validateResponse({...result,usage:{inputTokens:100,outputTokens:10,...bad}}));
    assert.throws(()=>migrateEvent({v:1,kind:'usage',at:'now',usage:{inputTokens:100,outputTokens:10,...bad}}));
  }
});

test('summary counts only messages/calls, has truthful nulls, partial legacy totals and complete-cache coverage', () => {
  const events = [message('user'),message('assistant'),usage({inputTokens:1000,outputTokens:100,reported:true,cachedInputTokens:900,durationMs:2000}),message('tool')];
  assert.deepEqual(desktopUsageSummary(events),{turns:1,steps:1,inputTokens:1000,outputTokens:100,totalTokens:1100,tokensPerSecond:50,cachedInputTokens:900,cacheHitPercent:90,contextPercent:null,partial:false});
  const missing = desktopUsageSummary([...events,message('assistant'),usage({inputTokens:0,outputTokens:0,reported:false,durationMs:10})]);
  assert.equal(missing.totalTokens,1100); assert.equal(missing.partial,true); assert.equal(missing.tokensPerSecond,null); assert.equal(missing.cacheHitPercent,null);
  const legacy = desktopUsageSummary([message('assistant'),usage({inputTokens:7,outputTokens:2})]);
  assert.equal(legacy.totalTokens,9); assert.equal(legacy.partial,true); assert.equal(legacy.tokensPerSecond,null);
  assert.equal(desktopUsageSummary([message('assistant'),usage({inputTokens:0,outputTokens:0})]).totalTokens,null);
  const zero = desktopUsageSummary([message('assistant'),usage({inputTokens:0,outputTokens:0,reported:true,cachedInputTokens:0,durationMs:1})]);
  assert.equal(zero.totalTokens,0); assert.equal(zero.partial,false); assert.equal(zero.cacheHitPercent,null);
  assert.equal(desktopUsageSummary([message('assistant')]).partial,true);
  assert.equal(desktopUsageSummary([]).totalTokens,null);
  const uncovered=desktopUsageSummary([...events,message('assistant'),usage({inputTokens:1,outputTokens:1,reported:true,durationMs:500})]);
  assert.equal(uncovered.partial,false); assert.equal(uncovered.cacheHitPercent,null); assert.equal(uncovered.tokensPerSecond,2);
});

test('usage metadata persists and reopens; failed turns retain earlier measured usage without inventing output', async () => {
  const home = await mkdtemp(fileURLToPath(new URL('../.desktop-usage-',import.meta.url)));
  const id='desktop-chat-'+randomUUID(); let fail=false;
  const server=await startTestServer(async(req,res)=>{
    for await(const _chunk of req) { /* consume local fixture request */ }
    if(fail){res.writeHead(503);res.end('{}');return;}
    res.end(JSON.stringify({model:'fixture',choices:[{message:{role:'assistant',content:'answer'},finish_reason:'stop'}],usage:{prompt_tokens:1000,completion_tokens:100,prompt_cache_hit_tokens:900}}));
  });
  const config={baseUrl:`http://127.0.0.1:${server.port}/v1`,model:'fixture',apiKey:'synthetic'};
  try {
    const result=await desktopModelSend(home,'hello',config,{},config,id);
    assert.equal(result.usageSummary.totalTokens,1100); assert.equal(result.usageSummary.cacheHitPercent,90);
    const stored=await new SessionStore({root:home}).read(id);
    const u=stored.find(e=>e.kind==='usage'); assert.ok(u?.kind==='usage');
    assert.equal(u.usage.reported,true); assert.equal(u.usage.cachedInputTokens,900); assert.ok(u.usage.durationMs!>0);
    assert.deepEqual((await desktopHistory(home,id)).usageSummary,result.usageSummary);
    fail=true; await assert.rejects(desktopModelSend(home,'failed request',config,{},config,id));
    const after=(await desktopHistory(home,id)).usageSummary;
    assert.equal(after.turns,2); assert.equal(after.steps,1); assert.equal(after.totalTokens,1100);
    assert.equal(after.tokensPerSecond,result.usageSummary.tokensPerSecond);
  } finally { await server.close(); await rm(home,{recursive:true,force:true}); }
});
