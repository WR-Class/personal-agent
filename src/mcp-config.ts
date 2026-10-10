import path from 'node:path';
import { oauthGrant, type OAuthGrant } from './mcp-oauth.ts';
import type { SecretStorage } from './desktop-providers.ts';
import { McpConfigError, mcpUrl } from './mcp-http-client.ts';
export { McpConfigError } from './mcp-http-client.ts';
export type McpServer = {id:string;name?:string;type?:'stdio'|'http';command?:string;args:string[];cwd?:string;url?:string;encrypted?:string;oauthEncrypted?:string};
const REDACTED = '[REDACTED]';
const fail = (message:string):never=>{throw new McpConfigError(message);};
function object(v:unknown):Record<string,unknown> { if(!v||typeof v!=='object'||Array.isArray(v))return fail('MCP 配置必须是 JSON 对象');return v as Record<string,unknown>; }
function fields(v:unknown,allowed:string[]) {const s=object(v);if(Object.keys(s).some(k=>!allowed.includes(k)))fail('MCP 配置含未知字段；仅支持 stdio 与 Streamable HTTP');return s;}
function text(v:unknown,max=2048):string {if(typeof v!=='string'||!v.trim()||v.length>max||/[\x00-\x1f\x7f]/.test(v))return fail('MCP 文本字段无效或过长');return v;}
function absolute(v:unknown):string {const s=text(v);if(!path.isAbsolute(s))return fail('本地 MCP 命令和目录须使用绝对路径（不通过 shell 启动 npx/cmd）');return path.resolve(s);}
export function mcpServer(v:unknown):McpServer {
  const s=fields(v,['id','name','type','command','args','cwd','url','encrypted','oauthEncrypted']);
  const id=text(s.id,48);if(!/^[a-z][a-z0-9_-]*$/.test(id))fail('MCP ID 须为小写字母开头，仅含字母数字 _ -');
  if(s.type!==undefined&&s.type!=='stdio'&&s.type!=='http')fail('当前支持 stdio 和 Streamable HTTP，不支持旧 SSE URL 传输');
  const base={id,...(s.name===undefined?{}:{name:text(s.name,80)}),...(s.encrypted===undefined?{}:{encrypted:text(s.encrypted,65536)})};
  if(s.type==='http') {
    if(s.command!==undefined||s.cwd!==undefined||(s.args!==undefined&&(!Array.isArray(s.args)||s.args.length)))fail('HTTP 配置不能包含本地命令');
    if(s.encrypted!==undefined&&s.oauthEncrypted!==undefined)fail('OAuth 与手动请求头不能同时保存');
    return {...base,type:'http',url:mcpUrl(s.url),args:[],...(s.oauthEncrypted===undefined?{}:{oauthEncrypted:text(s.oauthEncrypted,65536)})};
  }
  if(s.oauthEncrypted!==undefined)fail('OAuth 仅支持 HTTP MCP');
  if(s.url!==undefined)fail('远程 MCP 请设置 type: http');
  if(!Array.isArray(s.args??[])||(s.args as unknown[]|undefined)?.length!>32)fail('MCP 参数最多32项');
  const args=((s.args??[])as unknown[]).map(a=>a===''?'':text(a));
  return {...base,...(s.type?{type:'stdio' as const}:{}),command:absolute(s.command),args,...(s.cwd===undefined?{}:{cwd:absolute(s.cwd)})};
}
function endpoint(s:McpServer) {return JSON.stringify(s.type==='http'?['http',s.url]:['stdio',s.command,s.args,s.cwd??null]);}
function secure(storage?:SecretStorage):SecretStorage {
  if(!storage?.isEncryptionAvailable()||storage.getSelectedStorageBackend?.()==='basic_text')return fail('系统凭据加密不可用，拒绝保存或读取 MCP 密钥');return storage;
}
export function mcpSecrets(s:McpServer,storage?:SecretStorage):Record<string,string> {
  if(!s.encrypted)return {};
  try {const raw=JSON.parse(secure(storage).decryptString(Buffer.from(s.encrypted,'base64'))),obj=object(raw);
    if(Object.keys(obj).length>32||Object.values(obj).some(v=>typeof v!=='string'))fail('MCP 加密凭据无效');
    return obj as Record<string,string>;
  } catch {return fail('MCP 凭据无法解密，请重新填写');}
}
export function publicMcpServer(s:McpServer) {const {encrypted,oauthEncrypted,...rest}=s;return {...rest,hasCredentials:!!encrypted||!!oauthEncrypted,oauthAuthorized:!!oauthEncrypted};}
export function encryptOAuth(grant:OAuthGrant,storage?:SecretStorage){return secure(storage).encryptString(JSON.stringify(oauthGrant(grant))).toString('base64');}
export function decryptOAuth(s:McpServer,storage?:SecretStorage):OAuthGrant|undefined{
 if(!s.oauthEncrypted)return undefined;try{const grant=oauthGrant(JSON.parse(secure(storage).decryptString(Buffer.from(s.oauthEncrypted,'base64'))));if(grant.resource!==s.url)fail('OAuth 令牌地址绑定失效');return grant;}catch{return fail('OAuth 凭据无法解密或地址绑定失效，请重新授权');}
}
function secretMap(value:unknown,type:'http'|'stdio'):Record<string,string> {
  if(value===undefined)return {};
  const source=object(value),result:Record<string,string>=Object.create(null);if(Object.keys(source).length>32)fail('MCP 凭据字段最多32项');
  const seen=new Set<string>();
  for(const [key,value]of Object.entries(source)) {
    const name=text(key,128),lower=name.toLowerCase();
    if(seen.has(lower))fail('MCP 字段名称大小写重复');seen.add(lower);
    if(type==='http') {
      if(!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)||/^(host|connection|content-length|content-type|accept|cookie|origin|proxy-.*|sec-.*|mcp-.*|transfer-encoding)$/i.test(name))fail('MCP 请求头名称不允许');
    } else if(!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)||/^(PATH|PATHEXT|HOME|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|COMSPEC|SYSTEMROOT|WINDIR|NODE_OPTIONS|NODE_PATH|PYTHONPATH|PYTHONHOME|LD_.*|DYLD_.*|BASH_ENV|ENV|SHELL)$/i.test(name))fail('MCP 环境变量不能覆盖进程加载、路径或隔离目录');
    const v=value===''?'':text(value,8192);
    if(/\$\{/.test(v))fail('不能迁移 TRAE 连接器或变量占位符；请使用自己授权的令牌，配置不会继承其他客户端登录');
    result[name]=v;
  }
  return result;
}
export function exportMcpConfig(servers:McpServer[],storage?:SecretStorage):string {
  const entries:Record<string,unknown>=Object.create(null);
  for(const s of servers) {
    const secrets=mcpSecrets(s,storage),masked=Object.fromEntries(Object.keys(secrets).map(k=>[k,REDACTED]));
    entries[s.id]=s.type==='http'?{type:'http',url:s.url,...(s.oauthEncrypted?{oauth:REDACTED}:{}),...(Object.keys(masked).length?{headers:masked}:{})}
      :{command:s.command,args:s.args,...(s.cwd?{cwd:s.cwd}:{}),...(Object.keys(masked).length?{env:masked}:{})};
  }
  return JSON.stringify({mcpServers:entries},null,2);
}
export function importMcpConfig(json:unknown,existing:McpServer[],storage?:SecretStorage):McpServer[] {
  if(typeof json!=='string'||Buffer.byteLength(json)>128*1024)fail('MCP JSON 超过128KiB或不是文本');
  let raw:unknown;try{raw=JSON.parse(json as string);}catch{return fail('MCP JSON 语法无效');}
  const top=fields(raw,['mcpServers']),entries=object(top.mcpServers);
  if(Object.keys(entries).length>8)fail('最多8个 MCP 服务器');
  return Object.entries(entries).map(([id,value])=>{
    const item=fields(value,['type','command','args','cwd','url','headers','env','oauth']);
    const {headers,env,oauth,...plain}=item;
    const type=item.type==='http'||item.url!==undefined?'http':'stdio';
    if(item.type!==undefined&&item.type!==type)fail('MCP 传输类型与配置不一致');
    if(type==='http'&&env!==undefined||type==='stdio'&&headers!==undefined)fail('HTTP 使用 headers，本地进程使用 env');
    const spec=mcpServer({id,...plain,...(type==='http'?{type:'http'}:{})}),previous=existing.find(s=>s.id===id);
    const incoming=secretMap(type==='http'?headers:env,type),secrets:Record<string,string>=Object.create(null);
    for(const [key,value]of Object.entries(incoming)) {
      if(value===REDACTED) {
        if(!previous||endpoint(previous)!==endpoint(spec))fail('地址或命令已改变，不能复用隐藏凭据；请重新填写');
        const old=mcpSecrets(previous!,storage)[key];if(old===undefined)return fail('隐藏凭据不存在，请重新填写');secrets[key]=old;
      } else secrets[key]=value;
    }
    if(oauth!==undefined){if(oauth!==REDACTED||type!=='http'||headers!==undefined||!previous?.oauthEncrypted||endpoint(previous)!==endpoint(spec))fail('OAuth 只能原地址保留授权；更换地址请重新授权');spec.oauthEncrypted=previous!.oauthEncrypted;}
    if(Object.keys(secrets).length)spec.encrypted=secure(storage).encryptString(JSON.stringify(secrets)).toString('base64');
    return mcpServer(spec); // Canonical field order matches persisted reload and therefore its revision.
  });
}
