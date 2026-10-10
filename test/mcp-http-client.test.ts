import {test} from 'node:test';
import assert from 'node:assert/strict';
import type {IncomingMessage,ServerResponse} from 'node:http';
import {startTestServer} from './server-fixture.ts';
import {McpHttpClient,mcpUrl} from '../src/mcp-http-client.ts';
import {listMcpTools} from '../src/mcp-bridge.ts';
async function fixture(handler:(m:any,req:IncomingMessage,res:ServerResponse)=>void) {
  const server=await startTestServer(async(req,res)=>{let body='';for await(const b of req)body+=b;handler(body?JSON.parse(body):{},req,res);});
  return {url:`http://127.0.0.1:${server.port}/mcp`,close:()=>server.close()};
}
const reply=(res:ServerResponse,id:unknown,result:unknown)=>{res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id,result}));};
test('Streamable HTTP JSON and SSE initialize/session/pagination/tool roundtrip and DELETE',async()=>{
  const seen:string[]=[];
  const f=await fixture((m,req,res)=>{
    assert.equal(req.headers.authorization,'Bearer local-fixture');seen.push(req.method==='DELETE'?'DELETE':m.method);
    if(req.method==='DELETE'){assert.equal(req.headers['mcp-session-id'],'fixture-session');res.writeHead(204);res.end();return;}
    if(m.method==='initialize'){res.setHeader('Mcp-Session-Id','fixture-session');reply(res,m.id,{protocolVersion:'2025-03-26',capabilities:{tools:{}}});return;}
    assert.equal(req.headers['mcp-session-id'],'fixture-session');assert.equal(req.headers['mcp-protocol-version'],'2025-03-26');
    if(m.method==='notifications/initialized'){res.writeHead(202);res.end();return;}
    if(m.method==='tools/list'){reply(res,m.id,{tools:[{name:m.params?.cursor?'second':'first',inputSchema:{type:'object'}}],...(m.params?.cursor?{}:{nextCursor:'page2'})});return;}
    res.writeHead(200,{'content-type':'text/event-stream'});res.write(': keepalive\r\n\r\n');
    res.write('data: '+JSON.stringify({jsonrpc:'2.0',method:'notifications/progress',params:{}})+'\r\n\r\n');
    res.end('data: '+JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'REMOTE_RESULT'}]}})+'\r\n\r\n');
  });
  const client=new McpHttpClient(f.url,{Authorization:'Bearer local-fixture'});
  try{await client.initialize();assert.deepEqual((await listMcpTools(client)).map(t=>t.name),['first','second']);assert.deepEqual(await client.request('tools/call',{name:'first',arguments:{}}),{content:[{type:'text',text:'REMOTE_RESULT'}]});await client.closeAndWait();assert.equal(client.closed,true);assert.ok(seen.includes('DELETE'));await assert.rejects(client.request('tools/list'),/关闭/);}finally{await client.closeAndWait();await f.close();}
});
test('HTTP refuses redirects, unbounded responses, mismatched IDs, auth errors and unsupported server requests without echo',async()=>{
  for(const mode of ['redirect','large','wrong-id','auth','server-request']) {
    let calls=0;const f=await fixture((m,req,res)=>{calls++;if(mode==='redirect'){res.writeHead(307,{Location:'/secret-target'});res.end();}else if(mode==='large'){res.setHeader('content-type','application/json');res.end(' '.repeat(1024*1024+1));}else if(mode==='wrong-id')reply(res,999,{});else if(mode==='auth'){res.writeHead(401);res.end('SECRET_ECHO');}else{res.setHeader('content-type','text/event-stream');res.end('data: '+JSON.stringify({jsonrpc:'2.0',id:1,method:'sampling/createMessage'})+'\n\n');}});
    const client=new McpHttpClient(f.url);
    try{await assert.rejects(client.request('tools/list'),e=>e instanceof Error&&!e.message.includes('SECRET_ECHO'));assert.equal(calls,1);}finally{await client.closeAndWait();await f.close();}
  }
  for(const url of ['http://example.com/mcp','https://user:pass@example.com/mcp','https://example.com/mcp?token=secret'])assert.throws(()=>mcpUrl(url));
});
test('HTTP cancellation closes active body and does not retry side effects; timeout is bounded',async()=>{
  let ready!:()=>void;const started=new Promise<void>(resolve=>ready=resolve);
  const f=await fixture((_m,_req,res)=>{res.writeHead(200,{'content-type':'text/event-stream'});res.write(': waiting\n\n');ready();});
  const client=new McpHttpClient(f.url);
  try{const pending=client.request('tools/call',{name:'mutating'});const rejected=assert.rejects(pending,/取消|超时/);await started;await client.closeAndWait();await rejected;const timeout=new McpHttpClient(f.url,{},30);await assert.rejects(timeout.request('tools/list'),/取消|超时/);await timeout.closeAndWait();}finally{await client.closeAndWait();await f.close();}
});
