// Explicit operator diagnostic for the configured Docker gateway. Synthetic results only.
// Run inside the existing gateway container; credentials stay in that process, never in output.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const config = JSON.parse(fs.readFileSync('/app/config.json','utf8'));
const key = process.env.GATEWAY_KEY || config.auth?.gatewayKey || config.gatewayKey;
const model = process.env.PROBE_MODEL || 'claude-opus-4-8';
const tools = [{type:'function',function:{name:'list_directory',description:'List a synthetic test directory; results supplied by the diagnostic, no actual filesystem access.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}}];
async function request(messages,stream,choice) {
  const res = await fetch('http://127.0.0.1:8787/v1/chat/completions',{method:'POST',headers:{'content-type':'application/json',authorization:'Bearer '+key},body:JSON.stringify({model,max_tokens:1024,stream,messages,tools,tool_choice:choice}),signal:AbortSignal.timeout(120000),redirect:'error'});
  assert.equal(res.status,200,'gateway HTTP status');
  const reader=res.body.getReader(), decoder=new TextDecoder(); let text='',bytes=0;
  for(;;){const {done,value}=await reader.read();if(done)break;bytes+=value.byteLength;if(bytes>1024*1024){await reader.cancel();throw Error('oversize response');}text+=decoder.decode(value,{stream:true});}text+=decoder.decode();
  if(!stream){const data=JSON.parse(text);return data.choices[0].message;}
  const message={role:'assistant',content:'',tool_calls:[]};
  for(const line of text.split(/\r?\n/)){if(!line.startsWith('data:')||line.includes('[DONE]'))continue;const frame=JSON.parse(line.slice(5));assert.ok(!frame.error,'stream error');const delta=frame.choices?.[0]?.delta;if(!delta)continue;message.content+=delta.content||'';
    for(const tc of delta.tool_calls||[]){const index=tc.index||0;const call=message.tool_calls[index]||={id:'',type:'function',function:{name:'',arguments:''}};if(tc.id)call.id=tc.id;call.function.name+=tc.function?.name||'';call.function.arguments+=tc.function?.arguments||'';}}
  return message;
}
(async()=>{
  for(const stream of [false,true]){
    const messages=[{role:'user',content:'Diagnostic only: request list_directory for path ".". After its result, report the exact returned file name. Do not invent a listing.'}];
    const call=await request(messages,stream,'required');
    assert.equal(call.tool_calls?.length,1,'exactly one structured call required');
    const tool=call.tool_calls[0];assert.equal(tool.function.name,'list_directory');assert.deepEqual(JSON.parse(tool.function.arguments),{path:'.'});assert.ok(tool.id);
    const sentinel='synthetic-'+require('node:crypto').randomUUID()+'.txt';
    messages.push(call,{role:'tool',tool_call_id:tool.id,content:JSON.stringify({entries:[{name:sentinel,type:'file'}],truncated:false})});
    const final=await request(messages,stream,'none');
    assert.ok(final.content.includes(sentinel),'final answer must use unpredictable supplied tool result');
    assert.equal(final.tool_calls?.length||0,0,'none must not emit tools');
    console.log(JSON.stringify({pass:true,model,stream,tool:'list_directory',roundtrip:true,filesRead:0}));
  }
})().catch(e=>{console.error(JSON.stringify({pass:false,error:e.message}));process.exitCode=1;});
