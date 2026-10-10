import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, link, rm } from 'node:fs/promises';
import path from 'node:path';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { createDesktopCapabilities } from '../src/desktop-capabilities.ts';

async function fixture() {
  const base=await mkdtemp(path.join(process.cwd(),'.desktop-caps-')),home=path.join(base,'home'),root=path.join(base,'ws'),other=path.join(base,'other');
  await Promise.all([home,root,other].map(p=>mkdir(p)));
  const service=createDesktopCapabilities(home);
  const script=path.join(base,'server.cjs');
  await writeFile(script,`let buf='';process.stdin.setEncoding('utf8');process.stdin.on('data',chunk=>{buf+=chunk;let n;while((n=buf.indexOf('\\n'))>=0){const m=JSON.parse(buf.slice(0,n));buf=buf.slice(n+1);if(!m.id)continue;let result;if(m.method==='initialize')result={protocolVersion:'2025-06-18',capabilities:{tools:{}}};else if(m.method==='tools/list')result={tools:[{name:'echo',description:'fixture',inputSchema:{type:'object',properties:{text:{type:'string'}}},annotations:{readOnlyHint:true}}]};else if(m.method==='tools/call'){if(m.params.arguments.text==='wait')continue;result={content:[{type:'text',text:'echo:'+m.params.arguments.text+':secret='+String(process.env.CAPS_SECRET)}]};}process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');}});`);
  const cleanup=async()=>{await service.closeOwner('a');await service.closeOwner('b');assert.equal(path.dirname(base),process.cwd());await rm(base,{recursive:true,force:true});};
  return {base,home,root,other,service,script,cleanup};
}
function cryptoFixture() {
  const key=randomBytes(32);
  return {isEncryptionAvailable:()=>true,encryptString(value:string){const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]);},decryptString(value:Buffer){const decipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));decipher.setAuthTag(value.subarray(12,28));return Buffer.concat([decipher.update(value.subarray(28)),decipher.final()]).toString('utf8');}};
}
test('MCP JSON stores only encrypted credentials, redacts DTOs, binds retained secrets to exact endpoint and revision',async()=>{
  const f=await fixture(),storage=cryptoFixture(),service=createDesktopCapabilities(f.home,storage);
  try {
    const initial=await service.getMcpConfig();
    const json=JSON.stringify({mcpServers:{github:{type:'http',url:'https://api.githubcopilot.com/mcp/',headers:{Authorization:'Bearer SECRET_LOCAL_FIXTURE'}}}});
    const saved=await service.saveMcpConfig(json,initial.revision);assert.ok(!saved.json.includes('SECRET_LOCAL_FIXTURE'));assert.match(saved.json,/REDACTED/);
    const disk=await readFile(path.join(f.home,'desktop-capabilities.json'),'utf8');assert.ok(!disk.includes('SECRET_LOCAL_FIXTURE'));
    assert.ok(!JSON.stringify(await service.list('a',f.root)).includes('SECRET_LOCAL_FIXTURE'));assert.ok(!JSON.stringify(await service.list('a',f.root)).includes('encrypted'));
    assert.equal((await service.list('a',f.root)).servers[0]?.connected,false);
    await assert.rejects(service.saveMcpConfig(json,initial.revision),/改变/);
    const kept=await service.saveMcpConfig(saved.json,saved.revision);
    await assert.rejects(service.saveMcpConfig(kept.json.replace('api.githubcopilot.com','example.com'),kept.revision),/隐藏凭据/);
    await assert.rejects(service.saveMcpConfig(json.replace('SECRET_LOCAL_FIXTURE','${connector.github.ACCESS_TOKEN}'),kept.revision),/TRAE/);
    await assert.rejects(createDesktopCapabilities(f.home).getMcpConfig(),/解密/);
    await assert.rejects(service.saveMcpConfig(JSON.stringify({mcpServers:{local:{command:process.execPath,env:{NODE_OPTIONS:'--require arbitrary'}}}}),kept.revision),/环境变量/);
    await assert.rejects(service.saveMcpConfig(JSON.stringify({mcpServers:{remote:{type:'http',url:'https://example.com/mcp',headers:{Host:'other-host'}}}}),kept.revision),/请求头/);
  }finally{await service.closeOwner('a');await f.cleanup();}
});
test('remote MCP connects globally across roots, supports concurrent services and requires approval even in full mode',async()=>{
  const f=await fixture(),service=createDesktopCapabilities(f.home,cryptoFixture());let calls=0;
  const server=createServer(async(req,res)=>{
    let text='';for await(const b of req)text+=b;const m=text?JSON.parse(text):{};
    assert.equal(req.headers.authorization,'Bearer REMOTE_FIXTURE');
    if(m.method==='notifications/initialized'){res.writeHead(202);res.end();return;}
    const result=m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'remote-success'}]};
    if(m.method==='tools/call')calls++;res.setHeader('content-type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:m.id,result}));
  });await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
  try {
    const before=await service.getMcpConfig();const remote={type:'http',url:`http://127.0.0.1:${port}/mcp`,headers:{Authorization:'Bearer REMOTE_FIXTURE'}};await service.saveMcpConfig(JSON.stringify({mcpServers:{remote,second:remote}}),before.revision);
    for(const spec of (await service.list('a',null)).servers)await service.connect('a',null,spec.id,spec.revision);
    await service.closeOwner('a',true); // workspace/session transition preserves HTTP, not stdio
    for(const ws of [null,f.root,f.other]){assert.equal((await service.list('a',ws)).servers.filter(s=>s.connected).length,2);assert.equal((await service.tools('a',ws,'read')).length,2);}
    assert.deepEqual(await service.tools('b',f.root,'full'),[]);
    const tool=(await service.tools('a',f.root,'write'))[0]!;assert.equal((await tool.execute({},{workspaceRoot:f.other,preApproved:true,approve:async()=>false})).isError,true);assert.equal(calls,0);
    assert.equal((await tool.execute({},{workspaceRoot:f.root,approve:async()=>true})).content,'remote-success');assert.equal(calls,1);
    const config=await service.getMcpConfig();await service.saveMcpConfig('{"mcpServers":{}}',config.revision);assert.equal((await tool.execute({},{workspaceRoot:f.root,preApproved:true})).isError,true);
  }finally{await service.closeOwner('a');server.closeAllConnections();await new Promise<void>(r=>server.close(()=>r()));await f.cleanup();}
});
const skill={id:'review',scenarios:['review'],prompt:'Check evidence',priority:3};
test('trusted home skill CRUD is opt-in, persists, ignores workspace catalogues and revokes edited prompts',async()=>{
  const f=await fixture();try {
    await writeFile(path.join(f.root,'skills.json'),JSON.stringify({version:1,skills:[skill]}));
    assert.deepEqual(await f.service.skills(f.root),[]);
    await f.service.saveSkill(skill);assert.equal((await f.service.list('a',f.root)).skills[0]?.enabled,false);
    await f.service.enableSkill(f.root,'review',true);assert.deepEqual(await f.service.skills(f.root),[skill]);
    assert.deepEqual(await f.service.skills(f.other),[]);
    assert.deepEqual(await createDesktopCapabilities(f.home).skills(f.root),[skill]);
    await f.service.saveSkill({...skill,prompt:'Edited'});assert.deepEqual(await f.service.skills(f.root),[]);
    await f.service.enableSkill(f.root,'review',true);
    await writeFile(path.join(f.home,'skills.json'),JSON.stringify({version:1,skills:[{...skill,prompt:'External edit'}]}));
    assert.deepEqual(await f.service.skills(f.root),[]);
    await assert.rejects(f.service.saveSkill({...skill,tier:'full'}));
    await assert.rejects(f.service.enableSkill(f.root,'review','true'));
    await f.service.removeSkill('review');assert.deepEqual((await f.service.list('a',f.root)).skills,[]);
  }finally{await f.cleanup();}
});
test('state schema, absolute executable, hardlinks and malformed catalogue fail closed',async()=>{
  const f=await fixture();try {
    for(const bad of [{id:'a',command:'node',args:[]},{id:'a',command:process.execPath,args:[],env:{KEY:'secret'}},{id:'a',command:process.execPath,args:[],url:'https://server'},{id:'../bad',command:process.execPath,args:[]}])await assert.rejects(f.service.saveServer(bad));
    await f.service.saveSkill(skill);
    await link(path.join(f.home,'skills.json'),path.join(f.base,'alias.json'));
    await assert.rejects(f.service.skills(f.root),/不安全/);await rm(path.join(f.base,'alias.json'));
    await writeFile(path.join(f.home,'skills.json'),'{');await assert.rejects(f.service.skills(f.root),/JSON/);
    await writeFile(path.join(f.home,'skills.json'),JSON.stringify({version:1,skills:[]}));
    await f.service.saveServer({id:'echo',command:process.execPath,args:[f.script]});
    const state=JSON.parse(await readFile(path.join(f.home,'desktop-capabilities.json'),'utf8'));state.servers[0].env={TOKEN:'forbidden'};
    await writeFile(path.join(f.home,'desktop-capabilities.json'),JSON.stringify(state));await assert.rejects(f.service.list('a',f.root),/未知字段/);
  }finally{await f.cleanup();}
});
test('real stdio handshake/call obey owner/root/read-only boundaries, approval, scrubbed environment and stale disconnect',async()=>{
  const f=await fixture();const previous=process.env.CAPS_SECRET;process.env.CAPS_SECRET='must-not-leak';
  try {
    await f.service.saveServer({id:'echo',command:process.execPath,args:[f.script]});
    const spec=(await f.service.list('a',f.root)).servers[0]!;
    assert.equal(spec.connected,false);await assert.rejects(f.service.connect('a',f.root,'echo','wrong'),/改变/);
    await f.service.connect('a',f.root,'echo',spec.revision);
    assert.equal((await f.service.list('a',f.root)).servers[0]?.connected,true);
    assert.equal((await f.service.list('b',f.root)).servers[0]?.connected,false);
    assert.deepEqual(await f.service.tools('a',f.root,'read'),[]);
    assert.deepEqual(await f.service.tools('b',f.root,'full'),[]);
    assert.deepEqual(await f.service.tools('a',f.other,'full'),[]);
    const tool=(await f.service.tools('a',f.root,'write'))[0]!;assert.equal(tool.readOnly,false);
    const denied=await tool.execute({text:'hello'},{workspaceRoot:f.root,approve:async()=>false});assert.equal(denied.isError,true);
    const result=await tool.execute({text:'hello'},{workspaceRoot:f.root,preApproved:true});assert.equal(result.content,'echo:hello:secret=undefined');
    await f.service.disconnect('a','echo');assert.equal((await tool.execute({text:'stale'},{workspaceRoot:f.root,preApproved:true})).isError,true);
    await f.service.connect('a',f.root,'echo',spec.revision);await f.service.closeOwner('a');assert.equal((await f.service.list('a',f.root)).servers[0]?.connected,false);
  }finally{if(previous===undefined)delete process.env.CAPS_SECRET;else process.env.CAPS_SECRET=previous;await f.cleanup();}
});
test('abort closes and awaits live MCP process; modifying server revokes existing connection',async()=>{
  const f=await fixture();try {
    const spec={id:'echo',command:process.execPath,args:[f.script]};await f.service.saveServer(spec);
    const rev=(await f.service.list('a',f.root)).servers[0]!.revision;await f.service.connect('a',f.root,'echo',rev);
    const tool=(await f.service.tools('a',f.root,'full'))[0]!,controller=new AbortController();
    const run=tool.execute({text:'wait'},{workspaceRoot:f.root,preApproved:true,signal:controller.signal});controller.abort();
    assert.equal((await run).isError,true);assert.equal((await f.service.list('a',f.root)).servers[0]?.connected,false);
    await f.service.connect('a',f.root,'echo',rev);await f.service.saveServer({...spec,name:'Changed'});
    assert.equal((await f.service.list('a',f.root)).servers[0]?.connected,false);await assert.rejects(f.service.connect('a',f.root,'echo',rev),/改变/);
    const revised=(await f.service.list('a',f.root)).servers[0]!.revision;
    const cancelled=f.service.connect('a',f.root,'echo',revised);const rejected=assert.rejects(cancelled,/取消|失效|关闭/);await f.service.closeOwner('a');await rejected;
    assert.equal((await f.service.list('a',f.root)).servers[0]?.connected,false);
    const concurrent=await Promise.allSettled([f.service.connect('a',f.root,'echo',revised),f.service.connect('a',f.root,'echo',revised)]);
    assert.equal(concurrent.filter(r=>r.status==='fulfilled').length,1);await f.service.closeOwner('a');
    await f.service.removeServer('echo');assert.equal((await f.service.list('a',f.root)).servers.length,0);
  }finally{await f.cleanup();}
});
