import { createHash, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { McpConfigError, mcpUrl } from './mcp-http-client.ts';
import { readBoundedUtf8 } from './bounded-read.ts';

const fail=(message:string):never=>{throw new McpConfigError(message);};
const nonce=()=>randomBytes(32).toString('base64url');
// Public application identity supplied by the Personal Agent publisher; not a client secret.
const GITHUB_CLIENT_ID='Ov23liRxvqvUkmkJozch';
function text(value:unknown,max=8192):string {if(typeof value!=='string'||!value||value.length>max||/[\x00-\x20\x7f]/.test(value))return fail('OAuth 返回字段无效');return value;}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))return fail('OAuth 响应格式无效');return value as Record<string,unknown>;}
function endpoint(value:unknown,origin:string){const url=mcpUrl(value);if(new URL(url).origin!==origin||new URL(url).hash||new URL(url).search)fail('OAuth 端点必须与授权服务器同源且不含查询参数');return url;}
export type OAuthGrant={resource:string;issuer:string;tokenEndpoint:string;clientId:string;accessToken:string;refreshToken?:string;expiresAt?:number;scope:string;kind:'code'|'device'};
export type OAuthProgress={message:string;userCode?:string;verificationUri?:string};
type Hooks={signal:AbortSignal;openBrowser:(url:string)=>Promise<void>;progress:(status:OAuthProgress)=>void};
export function oauthGrant(value:unknown):OAuthGrant{
 const g=record(value),resource=mcpUrl(g.resource),issuer=mcpUrl(g.issuer),origin=new URL(issuer).origin;
 if(g.kind!=='code'&&g.kind!=='device')fail('OAuth 授权类型无效');
 if(g.kind==='device'&&(resource!=='https://api.githubcopilot.com/mcp/'&&resource!=='https://api.githubcopilot.com/mcp'||issuer!=='https://github.com/login/oauth'))fail('GitHub 授权绑定无效');
 if(g.kind==='code'&&origin!==new URL(resource).origin)fail('OAuth 授权来源不匹配');
 if(g.expiresAt!==undefined&&(!Number.isSafeInteger(g.expiresAt)||(g.expiresAt as number)<=0))fail('OAuth 有效期无效');
 // Returned grants can include thousands of scope characters (Cloudflare's public catalogue exceeds 7 KiB).
 // Keep the requested-scope UI bound separate from this bounded persisted provider response.
 if(typeof g.scope!=='string'||g.scope.length>16384||/[\x00-\x1f\x7f]/.test(g.scope))fail('OAuth 返回的权限范围格式无效或超过 16 KiB');
 return {resource,issuer,tokenEndpoint:endpoint(g.tokenEndpoint,origin),clientId:text(g.clientId,512),accessToken:text(g.accessToken),...(g.refreshToken===undefined?{}:{refreshToken:text(g.refreshToken)}),...(g.expiresAt===undefined?{}:{expiresAt:g.expiresAt as number}),scope:g.scope as string,kind:g.kind as 'code'|'device'};
}
async function request(url:string,signal:AbortSignal,body?:URLSearchParams|Record<string,unknown>,allowError=false){
 signal.throwIfAborted();let response:Response;
 try{response=await fetch(url,{method:body?'POST':'GET',redirect:'error',signal:AbortSignal.any([signal,AbortSignal.timeout(20000)]),headers:{Accept:'application/json',...(body?{'Content-Type':body instanceof URLSearchParams?'application/x-www-form-urlencoded':'application/json'}:{})},...(body?{body:body instanceof URLSearchParams?body.toString():JSON.stringify(body)}:{})});}catch{signal.throwIfAborted();return fail('OAuth 网络请求失败或超时；未跟随重定向');}
 let data:Record<string,unknown>;try{data=record(JSON.parse(await readBoundedUtf8(response.body! as unknown as AsyncIterable<Uint8Array>,128*1024,'OAuth')));}catch{return fail('OAuth 响应过大或格式无效');}
 if(!response.ok&&!allowError)fail('OAuth 服务拒绝请求（HTTP '+response.status+'）');return data;
}
function tokens(data:Record<string,unknown>,base:Omit<OAuthGrant,'accessToken'>):OAuthGrant{
 if(data.error)fail('OAuth 授权被拒绝、已过期或已撤销，请重新授权');
 if(typeof data.token_type!=='string'||data.token_type.toLowerCase()!=='bearer')fail('OAuth 只接受 Bearer 令牌');
 const seconds=data.expires_in;
 if(seconds!==undefined&&(typeof seconds!=='number'||!Number.isSafeInteger(seconds)||seconds<=0||seconds>31536000))fail('OAuth 令牌有效期无效');
 return oauthGrant({...base,accessToken:text(data.access_token),...(data.refresh_token===undefined?{}:{refreshToken:text(data.refresh_token)}),expiresAt:seconds===undefined?undefined:Date.now()+(seconds as number)*1000,scope:data.scope===undefined?base.scope:data.scope});
}
/** Same-origin public-client discovery only; cross-origin enterprise issuers need a separate reviewed integration. */
export async function authorizeCode(resourceInput:string,clientIdInput:string,scope:string,hooks:Hooks):Promise<OAuthGrant>{
 const resource=mcpUrl(resourceInput),origin=new URL(resource).origin;
 const metadata=await request(origin+'/.well-known/oauth-authorization-server',hooks.signal);
 if(metadata.issuer!==origin||!Array.isArray(metadata.code_challenge_methods_supported)||!metadata.code_challenge_methods_supported.includes('S256')||!Array.isArray(metadata.token_endpoint_auth_methods_supported)||!metadata.token_endpoint_auth_methods_supported.includes('none'))fail('此服务未声明受支持的公共客户端 PKCE 授权');
 const authorize=endpoint(metadata.authorization_endpoint,origin),tokenEndpoint=endpoint(metadata.token_endpoint,origin);
 const state=nonce(),verifier=nonce(),route='/oauth/callback';let callbackUrl='';
 let settle!:(value:string)=>void,reject!:(reason:Error)=>void;
 const code=new Promise<string>((resolve,no)=>{settle=resolve;reject=no;});void code.catch(()=>{});
 const server=createServer((req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('Content-Security-Policy',"default-src 'none'");res.setHeader('Content-Type','text/plain; charset=utf-8');res.setHeader('Referrer-Policy','no-referrer');
  if(req.method!=='GET'||req.headers.host!==new URL(callbackUrl).host||(req.url?.length??0)>16384){res.writeHead(400);res.end('Invalid callback');return;}
  let url:URL;try{if(!req.url?.startsWith('/')||req.url.startsWith('//'))throw Error();url=new URL(req.url,callbackUrl);}catch{res.writeHead(400);res.end('Invalid URL');return;}
  if(url.pathname!==route||url.searchParams.getAll('state').length!==1||url.searchParams.get('state')!==state){res.writeHead(400);res.end('Invalid state');return;}
  if(url.searchParams.has('iss')&&url.searchParams.get('iss')!==origin){res.writeHead(400);res.end('Invalid issuer');reject(new McpConfigError('OAuth 授权来源不匹配'));return;}
  if(url.searchParams.has('error')){res.end('授权未完成，请返回 Personal Agent。');reject(new McpConfigError('你已拒绝或取消 OAuth 授权'));return;}
  const value=url.searchParams.get('code');if(!value||url.searchParams.getAll('code').length!==1){res.writeHead(400);res.end('Invalid code');return;}
  try{text(value);res.end('已收到浏览器回调，客户端仍需交换令牌并保存。此页面不代表授权已保存或 MCP 已连接；请返回 Personal Agent 查看最终结果。');settle(value);}catch{res.writeHead(400);res.end('Invalid code');}
 });server.requestTimeout=10000;server.headersTimeout=10000;
 const abort=()=>{reject(new McpConfigError('OAuth 授权已取消或超时'));server.closeAllConnections();};
 hooks.signal.addEventListener('abort',abort,{once:true});
 try{
  hooks.signal.throwIfAborted();await new Promise<void>((yes,no)=>{server.once('error',no);server.listen(0,'127.0.0.1',()=>yes());});
  const address=server.address();if(!address||typeof address==='string')return fail('无法建立 OAuth 本机回调');callbackUrl='http://127.0.0.1:'+address.port+route;
  let clientId=clientIdInput;
  if(!clientId){
   if(!metadata.registration_endpoint)fail('此服务需要你注册 OAuth 应用并填写 Client ID');
   const reg=await request(endpoint(metadata.registration_endpoint,origin),hooks.signal,{client_name:'Personal Agent',redirect_uris:[callbackUrl],grant_types:['authorization_code','refresh_token'],response_types:['code'],token_endpoint_auth_method:'none'});
   if(reg.token_endpoint_auth_method!==undefined&&reg.token_endpoint_auth_method!=='none')fail('服务要求客户端机密，不能嵌入桌面程序');clientId=text(reg.client_id,512);
  }else text(clientId,512);
  const url=new URL(authorize);url.search=new URLSearchParams({response_type:'code',client_id:clientId,redirect_uri:callbackUrl,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',resource,...(scope?{scope}:{})}).toString();
  hooks.signal.throwIfAborted();hooks.progress({message:'请在浏览器完成授权，正在等待安全回调…'});await hooks.openBrowser(url.href);hooks.signal.throwIfAborted();
  const authCode=await code;hooks.signal.throwIfAborted();hooks.progress({message:'正在交换授权码…'});
  const data=await request(tokenEndpoint,hooks.signal,new URLSearchParams({grant_type:'authorization_code',client_id:clientId,code:authCode,code_verifier:verifier,redirect_uri:callbackUrl,resource}));
  return tokens(data,{resource,issuer:origin,tokenEndpoint,clientId,scope,kind:'code'});
 }finally{hooks.signal.removeEventListener('abort',abort);server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
}
export async function authorizeGitHub(resource:string,clientId:string,scope:string,hooks:Hooks):Promise<OAuthGrant>{
 clientId=clientId||GITHUB_CLIENT_ID;
 text(clientId,512);if(!['https://api.githubcopilot.com/mcp/','https://api.githubcopilot.com/mcp'].includes(resource))fail('GitHub OAuth 仅绑定官方 MCP 地址');
 const issuer='https://github.com/login/oauth',tokenEndpoint=issuer+'/access_token';
 const device=await request('https://github.com/login/device/code',hooks.signal,new URLSearchParams({client_id:clientId,scope}));
 const deviceCode=text(device.device_code),userCode=text(device.user_code,64);
 if(device.verification_uri!=='https://github.com/login/device')fail('GitHub 返回了非预期验证地址');
 if(typeof device.expires_in!=='number'||device.expires_in<=0||device.expires_in>1800)fail('GitHub 设备码有效期无效');
 let interval=typeof device.interval==='number'&&device.interval>0?Math.max(5,device.interval):5;if(interval>60)fail('GitHub 轮询间隔无效');
 const deadline=Date.now()+(device.expires_in as number)*1000;
 hooks.progress({message:'在浏览器输入设备码并确认授权。只输入本窗口显示的代码。',userCode,verificationUri:'https://github.com/login/device'});await hooks.openBrowser('https://github.com/login/device');
 while(Date.now()<deadline){await delay(interval*1000,undefined,{signal:hooks.signal});
  const data=await request(tokenEndpoint,hooks.signal,new URLSearchParams({grant_type:'urn:ietf:params:oauth:grant-type:device_code',client_id:clientId,device_code:deviceCode}),true);
  if(data.error==='authorization_pending')continue;if(data.error==='slow_down'){interval+=5;continue;}
  return tokens(data,{resource,issuer,tokenEndpoint,clientId,scope,kind:'device'});
 }return fail('GitHub 设备码已过期，请重新授权');
}
export async function refreshOAuth(grant:OAuthGrant,signal:AbortSignal):Promise<OAuthGrant>{
 const g=oauthGrant(grant);if(!g.refreshToken)return fail('OAuth 令牌已过期，请重新授权');
 const data=await request(g.tokenEndpoint,signal,new URLSearchParams({grant_type:'refresh_token',client_id:g.clientId,refresh_token:g.refreshToken,...(g.kind==='code'?{resource:g.resource}:{})}));
 return tokens(data,g);
}
export async function authorizeOAuth(resource:string,clientId:string,scope:string,hooks:Hooks){
 if(typeof scope!=='string'||scope.length>4096||/[\x00-\x1f\x7f]/.test(scope))fail('OAuth 权限范围无效');
 if(typeof clientId!=='string'||clientId.length>512)fail('OAuth Client ID 无效');
 const bounded={...hooks,signal:AbortSignal.any([hooks.signal,AbortSignal.timeout(10*60*1000)])};
 try{return ['https://api.githubcopilot.com/mcp/','https://api.githubcopilot.com/mcp'].includes(resource)?await authorizeGitHub(resource,clientId,scope,bounded):await authorizeCode(resource,clientId,scope,bounded);}catch(e){if(e instanceof McpConfigError)throw e;throw new McpConfigError('OAuth 授权未完成、已取消或超时；请重试');}
}
