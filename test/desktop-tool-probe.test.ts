import test from 'node:test';
import assert from 'node:assert/strict';
import {probeDesktopTools} from '../src/desktop-tool-probe.ts';
const config={baseUrl:'http://127.0.0.1:12345/v1',model:'fixture',apiKey:'fixture-private-key'};
test('tool probe distinguishes text-only HTTP success from structured function support',async()=>{
  const bodies:any[]=[];
  const mock=(message:any)=>async(_url:any,init:any)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({model:'fixture',choices:[{message,finish_reason:message.tool_calls?'tool_calls':'stop'}]}));};
  const text=await probeDesktopTools(config,mock({role:'assistant',content:'I only have read_tabular '+config.apiKey}) as typeof fetch);
  assert.equal(text.compatible,false);assert.doesNotMatch(text.response,/fixture-private-key/);
  const good=await probeDesktopTools(config,mock({role:'assistant',content:'',tool_calls:[{id:'one',type:'function',function:{name:'list_directory',arguments:'{"path":"."}'}}]}) as typeof fetch);
  assert.equal(good.compatible,true);assert.deepEqual(good.returned,['list_directory']);
  const wrong=await probeDesktopTools(config,mock({role:'assistant',content:'',tool_calls:[{id:'one',type:'function',function:{name:'read_tabular',arguments:'{}'}}]}) as typeof fetch);
  assert.equal(wrong.compatible,false);
  assert.ok(bodies.every(b=>b.tools.length===1&&b.tools[0].function.name==='list_directory'));
  assert.ok(bodies.every(b=>b.messages.length===1&&!JSON.stringify(b).includes('D:\\')));
});
test('tool probe failure is not misreported as incompatible response',async()=>{
  const r=await probeDesktopTools(config,(async()=>{throw Error('private transport detail');}) as typeof fetch);
  assert.equal(r.compatible,false);assert.match(r.detail,/无法判定/);assert.doesNotMatch(r.detail,/private transport/);
});
