import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { assertSafeStateDirectory, canonicalPath, configuredProtectedRoots } from './security-config.ts';
import { withSessionLease } from './session-lease.ts';
import { parseSkillCatalogue } from './skill-catalogue.ts';
import type { TaskPromptSkill } from './taskspec-prompt.ts';
import { buildToolEnvironment } from './tool-environment.ts';
import { startMcpClient } from './mcp-client.ts';
import { McpHttpClient, type McpTransport } from './mcp-http-client.ts';
import { authorizeOAuth, refreshOAuth, type OAuthProgress } from './mcp-oauth.ts';
import { encryptOAuth, decryptOAuth, mcpServer, publicMcpServer, mcpSecrets, importMcpConfig, exportMcpConfig, McpConfigError, type McpServer } from './mcp-config.ts';
import type { SecretStorage } from './desktop-providers.ts';
export { McpConfigError } from './mcp-config.ts';
import { listMcpTools, mcpToolToTool, type McpToolInfo } from './mcp-bridge.ts';
import type { Tool } from './tools.ts';

const MAX = 128 * 1024;
type Server = McpServer;
type Activation = { root: string; skills: { id: string; hash: string }[] };
type State = { v: 1; servers: Server[]; activations: Activation[] };
type Connection = { owner: string; root: string; spec: Server; revision: string; client: McpTransport; infos: readonly McpToolInfo[]; ready: boolean; expiresAt?:number };
const digest = (v: unknown) => createHash('sha256').update(JSON.stringify(v) ?? 'null').digest('hex');
function object(v: unknown, keys: string[]): Record<string, unknown> {
  if (!v || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) throw Error('配置含未知字段；请使用受支持的技能或 MCP JSON 格式');
  return v as Record<string, unknown>;
}
function text(v: unknown, max = 2048): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\x00-\x1f\x7f]/.test(v)) throw Error('文本字段无效或过长');
  return v;
}
function id(v: unknown): string {
  const s = text(v, 48); if (!/^[a-z][a-z0-9_-]*$/.test(s)) throw Error('ID 必须小写字母开头，仅含字母数字 _ -'); return s;
}
function absolute(v: unknown): string {
  const s = text(v); if (!path.isAbsolute(s)) throw Error('必须使用绝对路径'); return path.resolve(s);
}
const server = mcpServer;
function catalogue(raw: string): TaskPromptSkill[] {
  const skills = [...parseSkillCatalogue(raw, 'skills.json')];
  if (skills.length > 32) throw Error('最多32个技能');
  for (const s of skills) { id(s.id); if (s.scenarios.length > 32 || s.scenarios.some(x => x.length > 256) || s.prompt.length > 8192) throw Error('技能内容过长'); }
  return skills;
}
function state(raw: string): State {
  const s = object(JSON.parse(raw), ['v','servers','activations']);
  if (s.v !== 1 || !Array.isArray(s.servers) || s.servers.length > 8 || !Array.isArray(s.activations) || s.activations.length > 128) throw Error('能力配置版本或数量无效');
  const servers = s.servers.map(server);
  const activations = s.activations.map(v => {
    const a = object(v, ['root','skills']); if (!Array.isArray(a.skills) || a.skills.length > 32) throw Error('技能启用配置无效');
    const skills = a.skills.map(v => { const x = object(v, ['id','hash']); const hash = text(x.hash,64); if (!/^[a-f0-9]{64}$/.test(hash)) throw Error('技能签名无效'); return {id:id(x.id),hash}; });
    if (new Set(skills.map(x=>x.id)).size !== skills.length) throw Error('重复技能启用ID');
    return {root:absolute(a.root),skills};
  });
  if (new Set(servers.map(x=>x.id)).size !== servers.length || new Set(activations.map(x=>x.root)).size !== activations.length) throw Error('重复配置ID或工作区');
  return {v:1,servers,activations};
}

/** Trusted desktop host owns this service; methods never accept an arbitrary read/write filename. */
export function createDesktopCapabilities(home: string, secretStorage?: SecretStorage) {
  const connections = new Map<string, Connection>();
  const epochs = new Map<string, number>();
  const key = (owner: string, serverId: string) => JSON.stringify([text(owner,200),id(serverId)]);
  function file(name: 'skills.json'|'desktop-capabilities.json') {
    const root = assertSafeStateDirectory(home, {protectedRoots:configuredProtectedRoots(process.env)});
    if (root !== path.resolve(home)) throw Error('能力配置目录不能是链接');
    return path.join(root,name);
  }
  async function safe(p: string) {
    if (canonicalPath(p) !== p) throw Error('能力配置路径不能是链接');
    for (let cursor = p;;cursor=path.dirname(cursor)) {
      try { const s=await lstat(cursor); if(s.isSymbolicLink() || (cursor===p && (!s.isFile() || s.nlink!==1 || s.size>MAX))) throw Error('配置文件不安全或过大'); }
      catch(e) { if((e as NodeJS.ErrnoException).code!=='ENOENT') throw e; }
      if(path.dirname(cursor)===cursor)break;
    }
  }
  async function read(name: 'skills.json'|'desktop-capabilities.json', fallback: string) {
    const p=file(name); await safe(p); let h;
    try { h=await open(p,'r'); } catch(e) { if((e as NodeJS.ErrnoException).code==='ENOENT')return fallback; throw e; }
    try {
      const s=await h.stat(); if(!s.isFile() || s.nlink!==1 || s.size>MAX)throw Error('能力配置文件不安全');
      const bytes=Buffer.alloc(MAX+1);let n=0,count;
      do { count=(await h.read(bytes,n,bytes.length-n,null)).bytesRead;n+=count; } while(count&&n<bytes.length);
      if(n>MAX)throw Error('能力配置超过128KiB'); await safe(p);
      const leaf=await lstat(p); if(leaf.ino!==s.ino || leaf.dev!==s.dev)throw Error('能力配置读取期间改变');
      return new TextDecoder('utf-8',{fatal:true}).decode(bytes.subarray(0,n));
    } finally {await h.close();}
  }
  const load = async()=>state(await read('desktop-capabilities.json','{"v":1,"servers":[],"activations":[]}'));
  const loadSkills = async()=>catalogue(await read('skills.json','{"version":1,"skills":[]}'));
  async function write(name: 'skills.json'|'desktop-capabilities.json', value: unknown) {
    const p=file(name),body=JSON.stringify(value,null,2);if(Buffer.byteLength(body)>MAX)throw Error('能力配置超过128KiB');
    await safe(p);const tmp=p+'.'+randomUUID()+'.tmp';const h=await open(tmp,'wx',0o600);
    try {await h.writeFile(body,'utf8');await h.sync();} finally {await h.close();}
    try {await safe(p);await rename(tmp,p);} finally {try {await unlink(tmp);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}}
  }
  async function mutate<T>(fn:()=>Promise<T>) {
    const p=file('desktop-capabilities.json');await safe(p);await mkdir(path.dirname(p),{recursive:true});
    return withSessionLease(p,fn);
  }
  async function root(value: unknown) {
    const p=absolute(value);if(canonicalPath(p)!==p || !(await lstat(p)).isDirectory())throw Error('工作区必须是实际目录而非链接');return p;
  }
  async function closeConnection(k: string, c: Connection) {
    c.ready=false;await c.client.closeAndWait();if(connections.get(k)===c)connections.delete(k);
  }
  async function closeServer(serverId: string) {
    await Promise.all([...connections].filter(([,c])=>c.spec.id===serverId).map(([k,c])=>closeConnection(k,c)));
  }
  async function enabled(workspace: string|null|undefined, skills: TaskPromptSkill[], s: State) {
    if (!workspace) return [];
    const p=await root(workspace), approvals=s.activations.find(a=>a.root===p)?.skills??[];
    return skills.filter(skill=>approvals.some(a=>a.id===skill.id&&a.hash===digest(skill)));
  }
  const configSnapshot = (s:State) => ({revision:digest(s.servers),json:exportMcpConfig(s.servers,secretStorage)});
  return {
    async getMcpConfig() { return configSnapshot(await load()); },
    async saveMcpConfig(json: string, expectedRevision: string) {
      return mutate(async()=>{
        const s=await load();
        if(digest(s.servers)!==expectedRevision)throw new McpConfigError('MCP 配置已改变，请刷新后重试');
        const next=importMcpConfig(json,s.servers,secretStorage);
        for(const old of s.servers) if(digest(next.find(x=>x.id===old.id))!==digest(old))await closeServer(old.id);
        s.servers=next;await write('desktop-capabilities.json',s);return configSnapshot(s);
      });
    },
    async authorize(owner:string,resource:string,serverId:string,clientId:string,scope:string,expectedRevision:string,hooks:{signal:AbortSignal;openBrowser:(url:string)=>Promise<void>;progress:(value:OAuthProgress)=>void}){
      text(owner,200);id(serverId);const epoch=epochs.get(owner)||0;
      if(digest((await load()).servers)!==expectedRevision)throw new McpConfigError('配置已改变，请重新打开授权');
      // Refuse before opening any browser when secure persistence is unavailable.
      if(!secretStorage?.isEncryptionAvailable()||secretStorage.getSelectedStorageBackend?.()==='basic_text')throw new McpConfigError('系统凭据加密不可用，无法启动 OAuth');
      const grant=await authorizeOAuth(resource,clientId,scope,hooks);hooks.signal.throwIfAborted();
      return mutate(async()=>{hooks.signal.throwIfAborted();if((epochs.get(owner)||0)!==epoch)throw new McpConfigError('OAuth 已取消');const s=await load();if(digest(s.servers)!==expectedRevision)throw new McpConfigError('配置已改变，未保存 OAuth，请重新授权');
        const spec=server({id:serverId,type:'http',url:resource,args:[],oauthEncrypted:encryptOAuth(grant,secretStorage)});
        await closeServer(serverId);hooks.signal.throwIfAborted();s.servers=s.servers.filter(x=>x.id!==serverId);s.servers.push(spec);if(s.servers.length>8)throw new McpConfigError('最多8个 MCP 服务');await write('desktop-capabilities.json',s);return {id:serverId,revision:digest(spec)};
      });
    },
    async forgetOAuth(value:unknown){const sid=id(value);return mutate(async()=>{const s=await load(),spec=s.servers.find(x=>x.id===sid);if(!spec)return;await closeServer(sid);delete spec.oauthEncrypted;await write('desktop-capabilities.json',s);});},
    async list(owner: string, workspace?: string|null) {
      text(owner,200); const s=await load(), skills=await loadSkills(), active=await enabled(workspace,skills,s);
      return {workspaceRoot:workspace||null,skills:skills.map(skill=>({...skill,enabled:active.some(x=>x.id===skill.id)})),servers:s.servers.map(spec=>{
        const c=connections.get(key(owner,spec.id)),connected=!!c&&c.ready&&!c.client.closed&&(c.expiresAt===undefined||c.expiresAt>Date.now())&&(c.spec.type==='http'||c.root===workspace)&&c.revision===digest(spec);
        return {...publicMcpServer(spec),revision:digest(spec),connected,tools:connected?c.infos.map(t=>({name:t.name,description:t.description??''})):[]};
      })};
    },
    async saveSkill(value: unknown) {
      const skill=catalogue(JSON.stringify({version:1,skills:[value]}))[0]!;
      return mutate(async()=>{const skills=await loadSkills(),s=await load();const next=skills.filter(x=>x.id!==skill.id);next.push(skill);
        catalogue(JSON.stringify({version:1,skills:next}));
        // Revoke first: a crash between files fails closed, never silently activates an edited prompt.
        s.activations.forEach(a=>{a.skills=a.skills.filter(x=>x.id!==skill.id);});await write('desktop-capabilities.json',s);
        await write('skills.json',{version:1,skills:next});return skill;});
    },
    async removeSkill(value: unknown) {const sid=id(value);return mutate(async()=>{const skills=await loadSkills(),s=await load();s.activations.forEach(a=>{a.skills=a.skills.filter(x=>x.id!==sid);});await write('desktop-capabilities.json',s);await write('skills.json',{version:1,skills:skills.filter(x=>x.id!==sid)});});},
    async enableSkill(workspace: string, value: unknown, enable: unknown) {
      const p=await root(workspace),sid=id(value);if(typeof enable!=='boolean')throw Error('启用标记必须是布尔值');
      return mutate(async()=>{const s=await load(),skills=await loadSkills(),skill=skills.find(x=>x.id===sid);if(!skill)throw Error('技能不存在');
        let a=s.activations.find(a=>a.root===p);if(!a){if(s.activations.length>=128)throw Error('工作区启用记录已满');a={root:p,skills:[]};s.activations.push(a);}
        a.skills=a.skills.filter(x=>x.id!==sid);if(enable)a.skills.push({id:sid,hash:digest(skill)});await write('desktop-capabilities.json',s);});
    },
    async skills(workspace?: string|null) {return enabled(workspace,await loadSkills(),await load());},
    async saveServer(value: unknown) {const raw=object(value,['id','name','type','command','args','cwd','url']);const spec=server(raw);return mutate(async()=>{const s=await load();await closeServer(spec.id);s.servers=s.servers.filter(x=>x.id!==spec.id);s.servers.push(spec);if(s.servers.length>8)throw Error('最多8个MCP服务器');await write('desktop-capabilities.json',s);return spec;});},
    async removeServer(value: unknown) {const sid=id(value);return mutate(async()=>{const s=await load();await closeServer(sid);s.servers=s.servers.filter(x=>x.id!==sid);await write('desktop-capabilities.json',s);});},
    async connect(owner: string, workspace: string|null, value: unknown, expectedRevision: string, signal:AbortSignal=AbortSignal.timeout(60000)) {
      const epoch=epochs.get(owner)||0;
      const sid=id(value),k=key(owner,sid),s=await load();let spec=s.servers.find(x=>x.id===sid);
      const p=spec?.type==='http'?'':await root(workspace as string);
      if(!spec || digest(spec)!==expectedRevision)throw Error('服务器配置已改变，请重新确认启动');
      const old=connections.get(k);if(old?.expiresAt!==undefined&&old.expiresAt<=Date.now())await closeConnection(k,old);
      if(connections.has(k))throw Error('服务器已连接或尚未清理，请先断开');
      let grant=decryptOAuth(spec,secretStorage);
      if(grant?.expiresAt!==undefined&&grant.expiresAt<=Date.now()+60000){
        // Hold the cross-process lease through refresh redemption and rotation persistence.
        spec=await mutate(async()=>{signal.throwIfAborted();if((epochs.get(owner)||0)!==epoch)throw new McpConfigError('连接已取消');const current=await load(),entry=current.servers.find(x=>x.id===sid);if(!entry||digest(entry)!==expectedRevision)throw new McpConfigError('授权配置已变化，请重新连接');
          const refreshed=await refreshOAuth(decryptOAuth(entry,secretStorage)!,signal);await closeServer(sid);entry.oauthEncrypted=encryptOAuth(refreshed,secretStorage);await write('desktop-capabilities.json',current);return entry;});expectedRevision=digest(spec);grant=decryptOAuth(spec,secretStorage);
      }
      signal.throwIfAborted();const secrets=grant?{Authorization:'Bearer '+grant.accessToken}:mcpSecrets(spec,secretStorage);
      let environment:ReturnType<typeof buildToolEnvironment>|undefined;
      if(spec.type!=='http') {
        if(!spec.command || (await lstat(spec.command)).isSymbolicLink() || !(await lstat(spec.command)).isFile() || canonicalPath(spec.command)!==spec.command || /\.(cmd|bat)$/i.test(spec.command))throw Error('MCP命令必须是实际可执行文件，不经 shell 执行脚本');
        const cwd=spec.cwd?await root(spec.cwd):p;
        const base=buildToolEnvironment({workspaceRoot:cwd,agentHome:home});environment={...base,env:{...base.env,...secrets}};
      }
      if((epochs.get(owner)||0)!==epoch)throw Error('启动已取消');
      if(connections.has(k))throw Error('服务器连接已由另一启动占用');
      const client:McpTransport=spec.type==='http'?new McpHttpClient(spec.url!,secrets):startMcpClient({command:spec.command!,args:spec.args},environment!);
      const c:Connection={owner,root:p,spec,revision:expectedRevision,client,infos:[],ready:false,expiresAt:grant?.expiresAt};connections.set(k,c);
      const abort=()=>{void closeConnection(k,c).catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
      try {signal.throwIfAborted();await client.initialize('personal-agent-desktop');const infos=await listMcpTools(client);
        if(infos.length>256 || Buffer.byteLength(JSON.stringify(infos))>512*1024 || new Set(infos.map(t=>t.name)).size!==infos.length || infos.some(t=>!/^[-A-Za-z0-9_]+$/.test(t.name)||`mcp__${sid}__${t.name}`.length>64))throw Error('MCP工具目录过大或工具名无效');
        if((epochs.get(owner)||0)!==epoch || connections.get(k)!==c || client.closed || digest((await load()).servers.find(x=>x.id===sid))!==expectedRevision)throw Error('连接已失效或配置已改变');
        c.infos=infos;c.ready=true;return {id:sid,connected:true,tools:infos.map(t=>({name:t.name,description:t.description??''}))};
      } catch(e) {await closeConnection(k,c);throw e;}finally{signal.removeEventListener('abort',abort);}
    },
    async disconnect(owner: string, value: unknown) {const k=key(owner,id(value));epochs.set(owner,(epochs.get(owner)||0)+1);const c=connections.get(k);if(c)await closeConnection(k,c);},
    async closeOwner(owner: string, preserveRemote=false) {text(owner,200);epochs.set(owner,(epochs.get(owner)||0)+1);await Promise.all([...connections].filter(([,c])=>c.owner===owner&&(!preserveRemote||c.spec.type!=='http')).map(([k,c])=>closeConnection(k,c)));},
    async tools(owner: string, workspace: string|null, permission: 'read'|'write'|'full'): Promise<Tool[]> {
      text(owner,200);if(!['read','write','full'].includes(permission))throw Error('权限无效');
      const p=workspace?await root(workspace):'',s=await load();const result:Tool[]=[];
      for(const [k,c] of connections) {
        if(c.expiresAt!==undefined&&c.expiresAt<=Date.now()){await closeConnection(k,c);continue;}
        if(c.owner!==owner||(c.spec.type!=='http'&&(c.root!==p||permission==='read'||!p))||!c.ready||c.client.closed||digest(s.servers.find(x=>x.id===c.spec.id))!==c.revision)continue;
        for(const info of c.infos) {const tool=mcpToolToTool(c.spec.id,info,c.client);result.push({...tool,async execute(args,context){
          const valid=()=>connections.get(k)===c&&c.ready&&!c.client.closed&&(c.expiresAt===undefined||c.expiresAt>Date.now())&&(c.spec.type==='http'||context.workspaceRoot===p);
          if(!valid())return {content:'MCP连接已失效，请重新连接',isError:true};
          let cleanup:Promise<void>|undefined;const abort=()=>{cleanup=closeConnection(k,c);void cleanup.catch(()=>{});};
          if(context.signal?.aborted)abort();else context.signal?.addEventListener('abort',abort,{once:true});
          try {if(context.signal?.aborted)return {content:'MCP调用已取消',isError:true};return await tool.execute(args,{...context,...(c.spec.type==='http'?{preApproved:false,grants:[]}:{}),approve:context.approve?async prompt=>{const approved=await context.approve!(prompt);return approved&&valid()&&!context.signal?.aborted;}:undefined});}
          finally {context.signal?.removeEventListener('abort',abort);if(cleanup)await cleanup;}
        }});}
      } return result;
    },
  };
}
