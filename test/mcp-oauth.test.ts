import test from 'node:test';
import assert from 'node:assert/strict';
import { request as httpRequest } from 'node:http';
import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { startTestServer } from './server-fixture.ts';
import { authorizeOAuth, refreshOAuth, oauthGrant } from '../src/mcp-oauth.ts';
import { createDesktopCapabilities } from '../src/desktop-capabilities.ts';

const longScope=Array.from({length:384},(_,i)=>`cloudflare-permission-${i}:read`).join(' ');
async function fixture(){
 let origin='',challenge='',redirect='',refreshes=0,exchanges=0,mode='ok';const calls:{url:string;body:Record<string,string>}[]=[];
 const server=await startTestServer(async(req,res)=>{res.setHeader('content-type','application/json');let raw='';for await(const b of req)raw+=b;
  const json=(value:unknown)=>res.end(JSON.stringify(value));const form=Object.fromEntries(new URLSearchParams(raw));calls.push({url:req.url!,body:form});
  if(req.url==='/.well-known/oauth-authorization-server')return json({issuer:origin,authorization_endpoint:origin+'/authorize',token_endpoint:mode==='cross'?'https://untrusted.invalid/token':origin+'/token',registration_endpoint:origin+'/register',code_challenge_methods_supported:mode==='plain'?['plain']:['S256'],token_endpoint_auth_methods_supported:['none']});
  if(req.url==='/register'){const b=JSON.parse(raw);redirect=b.redirect_uris[0];assert.equal(b.token_endpoint_auth_method,'none');return json({client_id:'public-fixture',token_endpoint_auth_method:'none'});}
  if(req.url==='/token'){
   if(form.grant_type==='refresh_token'){refreshes++;assert.equal(form.refresh_token,'REFRESH_SENTINEL');return json({access_token:'ROTATED_ACCESS',refresh_token:'ROTATED_REFRESH',token_type:'Bearer',expires_in:3600});}
   exchanges++;assert.equal(form.code,'TEST_CODE');assert.equal(form.redirect_uri,redirect);assert.equal(form.resource,origin+'/mcp');assert.equal(createHash('sha256').update(form.code_verifier!).digest('base64url'),challenge);
   return json({access_token:'ACCESS_SENTINEL',refresh_token:'REFRESH_SENTINEL',token_type:'Bearer',expires_in:1,scope:mode==='oversized'?'x'.repeat(16385):mode==='invalid'?['read']:mode==='control'?'read\nwrite':longScope});
  }
  if(req.url==='/mcp'){if(req.method==='DELETE'){res.writeHead(204);return res.end();}assert.equal(req.headers.authorization,'Bearer ROTATED_ACCESS');const m=JSON.parse(raw);if(m.id===undefined){res.writeHead(202);return res.end();}return json({jsonrpc:'2.0',id:m.id,result:m.method==='initialize'?{protocolVersion:'2025-06-18',capabilities:{tools:{}}}:{tools:[]}});}
  res.writeHead(404);json({});
 });origin='http://127.0.0.1:'+server.port;
 const browser=async(input:string)=>{const u=new URL(input);assert.equal(u.origin,origin);assert.equal(u.searchParams.get('code_challenge_method'),'S256');challenge=u.searchParams.get('code_challenge')!;
  const callback=new URL(u.searchParams.get('redirect_uri')!);assert.equal(callback.href,redirect);callback.search=new URLSearchParams({state:u.searchParams.get('state')!,code:'TEST_CODE',iss:origin}).toString();
  await new Promise<void>((resolve,reject)=>{const req=httpRequest({hostname:callback.hostname,port:callback.port,path:'http://[',headers:{Host:callback.host}},res=>{assert.equal(res.statusCode,400);res.resume();res.on('end',resolve);});req.on('error',reject);req.end();});
  const forged=new URL(callback);forged.searchParams.set('state','WRONG');assert.equal((await fetch(forged)).status,400);assert.match(await (await fetch(callback)).text(),/不代表授权已保存/);
 };
 return {origin,server,browser,calls,setMode:(v:string)=>{mode=v;},counts:()=>({refreshes,exchanges})};
}
function storage(){const key=randomBytes(32);return {isEncryptionAvailable:()=>true,encryptString(value:string){const iv=randomBytes(12),c=createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([c.update(value,'utf8'),c.final()]);return Buffer.concat([iv,c.getAuthTag(),body]);},decryptString(value:Buffer){const d=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));d.setAuthTag(value.subarray(12,28));return Buffer.concat([d.update(value.subarray(28)),d.final()]).toString();}};}

test('OAuth PKCE validates state, exact resource, token binding, encrypted persistence, refresh rotation and forget',async()=>{
 const f=await fixture(),base=await mkdtemp(path.resolve('.test-artifacts/oauth-')),home=path.join(base,'home'),root=path.join(base,'workspace');await mkdir(home);await mkdir(root);const crypto=storage(),service=createDesktopCapabilities(home,crypto);
 try{
  const config=await service.getMcpConfig(),saved=await service.authorize('owner',f.origin+'/mcp','fixture','','',config.revision,{signal:AbortSignal.timeout(10000),openBrowser:f.browser,progress:()=>{}});
  assert.equal(f.counts().exchanges,1);const disk=await readFile(path.join(home,'desktop-capabilities.json'),'utf8');assert.ok(!disk.includes('ACCESS_SENTINEL'));assert.ok(!disk.includes('REFRESH_SENTINEL'));
  const publicState=await service.list('owner',root);assert.equal(publicState.servers[0]!.oauthAuthorized,true);assert.ok(!JSON.stringify(publicState).includes('oauthEncrypted'));assert.equal(publicState.servers[0]!.connected,false);
  const config2=await service.getMcpConfig();assert.match(config2.json,/"oauth": "\[REDACTED\]"/);await assert.rejects(service.saveMcpConfig(config2.json.replace(f.origin,'https://other.example'),config2.revision),/OAuth/);
  await service.saveMcpConfig(config2.json,config2.revision);const attempts=await Promise.allSettled([service.connect('owner',root,'fixture',saved.revision),service.connect('second',root,'fixture',saved.revision)]);assert.equal(attempts.filter(x=>x.status==='fulfilled').length,1);assert.equal(f.counts().refreshes,1);if(attempts[0]!.status==='rejected'){await service.closeOwner('second');await service.connect('owner',root,'fixture',(await service.list('owner',root)).servers[0]!.revision);}assert.equal((await service.list('owner',root)).servers[0]!.connected,true);
  const reloaded=createDesktopCapabilities(home,crypto);assert.equal((await reloaded.list('another',root)).servers[0]!.oauthAuthorized,true);assert.equal((await reloaded.list('another',root)).servers[0]!.connected,false);
  const persisted=JSON.parse(await readFile(path.join(home,'desktop-capabilities.json'),'utf8'));const grant=JSON.parse(crypto.decryptString(Buffer.from(persisted.servers[0].oauthEncrypted,'base64')));assert.equal(grant.refreshToken,'ROTATED_REFRESH');assert.equal(grant.scope,longScope);assert.ok(longScope.length>4096);
  const clock=Date.now;try{Date.now=()=>clock()+7200000;assert.equal((await service.list('owner',root)).servers[0]!.connected,false);assert.deepEqual(await service.tools('owner',root,'write'),[]);}finally{Date.now=clock;}
  await service.forgetOAuth('fixture');assert.equal((await service.list('owner',root)).servers[0]!.oauthAuthorized,false);assert.equal((await service.list('owner',root)).servers[0]!.connected,false);
 }finally{await service.closeOwner('owner');await f.server.close();await rm(base,{recursive:true,force:true});}
});
test('OAuth rejects malformed or excessive returned scope instead of hiding it behind requested scope',async()=>{const f=await fixture();try{for(const mode of ['oversized','invalid','control']){f.setMode(mode);await assert.rejects(authorizeOAuth(f.origin+'/mcp','','',{signal:AbortSignal.timeout(5000),openBrowser:f.browser,progress:()=>{}}),/返回的权限范围/);}}finally{await f.server.close();}});
test('OAuth refuses cross-origin endpoints and missing S256 before browser or registration',async()=>{const f=await fixture();try{for(const mode of ['cross','plain']){f.setMode(mode);await assert.rejects(authorizeOAuth(f.origin+'/mcp','','',{signal:AbortSignal.timeout(5000),openBrowser:async()=>assert.fail('must not launch'),progress:()=>{}}),/同源|PKCE/);}assert.equal(f.calls.some(c=>c.url==='/register'),false);}finally{await f.server.close();}});
test('OAuth cancel and denial close callback listener and never exchange a token',async()=>{const f=await fixture();try{for(const mode of ['cancel','deny']){const controller=new AbortController();let callback='';await assert.rejects(authorizeOAuth(f.origin+'/mcp','','',{signal:controller.signal,progress:()=>{},openBrowser:async input=>{const u=new URL(input),c=new URL(u.searchParams.get('redirect_uri')!);callback=c.href;if(mode==='cancel')controller.abort();else{c.search=new URLSearchParams({state:u.searchParams.get('state')!,error:'access_denied'}).toString();await fetch(c);}}}),/取消|拒绝/);await assert.rejects(fetch(callback));}assert.equal(f.counts().exchanges,0);}finally{await f.server.close();}});
test('OAuth refuses unsafe persisted refresh bindings before network',async()=>{
 assert.throws(()=>oauthGrant({kind:'code',resource:'https://service.test/mcp',issuer:'https://evil.test',tokenEndpoint:'https://evil.test/token',clientId:'client',accessToken:'secret',scope:''}),/来源/);
 await assert.rejects(refreshOAuth({kind:'code',resource:'https://service.test/mcp',issuer:'https://service.test',tokenEndpoint:'https://service.test/token',clientId:'client',accessToken:'secret',scope:''},AbortSignal.timeout(100)),/重新授权/);
});
for(const clientId of ['', 'OWN_CLIENT_ID'])test('GitHub device OAuth uses '+(clientId?'explicit':'publisher default')+' client ID without secret and only official browser URL',async()=>{
 const original=globalThis.fetch,requests:{url:string;body:URLSearchParams}[]=[],progress:unknown[]=[];
 globalThis.fetch=(async(input,options)=>{const url=String(input),body=new URLSearchParams(String(options?.body||''));requests.push({url,body});assert.equal(body.has('client_secret'),false);assert.equal(body.get('client_id'),clientId||'Ov23liRxvqvUkmkJozch');return Response.json(url.endsWith('/device/code')?{device_code:'DEVICE_SECRET',user_code:'ABCD-EFGH',verification_uri:'https://github.com/login/device',interval:5,expires_in:60}:{access_token:'GITHUB_ACCESS',token_type:'bearer',scope:'read:user'});}) as typeof fetch;
 try{const grant=await authorizeOAuth('https://api.githubcopilot.com/mcp/',clientId,'read:user',{signal:AbortSignal.timeout(10000),openBrowser:async url=>assert.equal(url,'https://github.com/login/device'),progress:p=>progress.push(p)});assert.equal(grant.kind,'device');assert.equal(grant.clientId,clientId||'Ov23liRxvqvUkmkJozch');assert.equal(grant.accessToken,'GITHUB_ACCESS');assert.ok(!JSON.stringify(progress).includes('DEVICE_SECRET'));assert.equal(requests.length,2);assert.equal(requests[1]!.body.get('grant_type'),'urn:ietf:params:oauth:grant-type:device_code');}finally{globalThis.fetch=original;}
});
