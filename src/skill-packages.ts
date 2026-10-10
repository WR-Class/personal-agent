import path from 'node:path';
import { mcpUrl } from './mcp-http-client.ts';
import { createHash, randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { lstat, mkdir, open, readdir, rename, rm, unlink } from 'node:fs/promises';
import { parseDocument } from 'yaml';
import * as yauzl from 'yauzl';
import { assertSafeStateDirectory, canonicalPath, configuredProtectedRoots } from './security-config.ts';
import { withSessionLease } from './session-lease.ts';
import type { Tool } from './tools.ts';

const MAX_FILE = 4 * 1024 * 1024, MAX_TOTAL = 32 * 1024 * 1024, MAX_FILES = 2000;
const hash = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
type Skill = { id: string; name: string; description: string; path: string };
type Package = { id: string; name: string; version: string; enabled: boolean; skills: Skill[]; files: number; bytes: number; warnings: string[]; hashes: Record<string, string> };
type Registry = { version: 1; packages: Package[] };
type Tree = Map<string, Buffer>;
export class SkillPackageError extends Error { constructor(message: string) { super(message); this.name = 'SkillPackageError'; } }
function fail(message: string): never { throw new SkillPackageError(message); }
function slug(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,95}$/.test(value) || value === '.' || value === '..') fail('插件名称或版本格式无效');
  return value as string;
}
function relative(value: string): string {
  if (!value || value.includes('\\') || value.startsWith('/') || /[\x00-\x1f\x7f:]/.test(value)) fail('插件路径无效');
  const parts = value.split('/');
  if (parts.some(p => !p || p === '.' || p === '..' || /[. ]$/.test(p) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(p))) fail('插件路径无效');
  if (parts.some(p => /^\.env(?:\.|$)|^\.ssh$|^\.git$|^credentials(?:\.|$)|^id_(rsa|ed25519)$|\.(?:pem|p12|pfx|key)$/i.test(p))) fail('插件包含不允许导入的凭据或仓库目录');
  return parts.join('/');
}
function inside(root: string, target: string) {
  const rel = path.relative(root, target);
  if (rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) fail('路径超出插件目录');
}
async function safe(target: string, missing = false) {
  if (canonicalPath(target) !== target) fail('插件路径不能包含链接');
  for (let cursor = target;; cursor = path.dirname(cursor)) {
    try { const s = await lstat(cursor); if (s.isSymbolicLink() || (s.isFile() && s.nlink !== 1)) fail('插件路径不能包含链接'); }
    catch (e) { if (!missing || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (path.dirname(cursor) === cursor) break;
  }
}
async function bytes(file: string, max = MAX_FILE): Promise<Buffer> {
  await safe(file); const h = await open(file, 'r');
  try {
    const stat = await h.stat(); if (!stat.isFile() || stat.nlink !== 1 || stat.size > max) fail('插件文件不安全或过大');
    const data = Buffer.alloc(Math.min(max, stat.size) + 1); let size = 0;
    while (size < data.length) { const got = await h.read(data, size, data.length - size, null); if (!got.bytesRead) break; size += got.bytesRead; }
    if (size > max) fail('插件文件过大');
    await safe(file); const current = await lstat(file);
    if (stat.ino !== current.ino || stat.dev !== current.dev || stat.size !== size) fail('插件文件读取期间发生变化');
    return Buffer.from(data.subarray(0, size));
  } finally { await h.close(); }
}
const utf8 = (data: Buffer) => new TextDecoder('utf-8', { fatal: true }).decode(data);
function add(tree: Tree, name: string, data: Buffer) {
  name = relative(name);
  if ([...tree.keys()].some(k => k.toLowerCase() === name.toLowerCase())) fail('插件含重复或大小写冲突路径');
  if (tree.size >= MAX_FILES || data.length > MAX_FILE || [...tree.values()].reduce((n, b) => n + b.length, 0) + data.length > MAX_TOTAL) fail('插件超过文件数或大小限制');
  tree.set(name, data);
}
async function directoryTree(root: string): Promise<Tree> {
  const tree: Tree = new Map(); let nodes = 0;
  async function visit(dir: string, prefix = '', depth = 0) {
    if (depth > 32) fail('插件目录过深'); await safe(dir);
    for (const item of await readdir(dir, { withFileTypes: true })) {
      if (++nodes > MAX_FILES * 2) fail('插件目录条目过多');
      const name = relative(prefix + item.name), full = path.join(dir, item.name); await safe(full);
      if (item.isDirectory()) await visit(full, name + '/', depth + 1);
      else if (item.isFile()) add(tree, name, await bytes(full));
      else fail('插件只允许普通目录和文件');
    }
  }
  await visit(root); return tree;
}
async function zipTree(file: string): Promise<Tree> {
  const source = await bytes(file, 64 * 1024 * 1024);
  const zip = await new Promise<yauzl.ZipFile>((resolve, reject) => yauzl.fromBuffer(source, { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true }, (e, z) => e ? reject(e) : resolve(z!)));
  return new Promise((resolve, reject) => {
    const tree: Tree = new Map(), names = new Set<string>(); let nodes = 0, declared = 0, done = false;
    const stop = (e: unknown) => { if (done) return; done = true; zip.close(); reject(e); };
    zip.on('error', stop);
    zip.on('end', () => { if (!done) { done = true; resolve(tree); } });
    zip.on('entry', (entry: yauzl.Entry) => { void (async () => {
      if (++nodes > MAX_FILES * 2) fail('ZIP 条目过多');
      const dir = entry.fileName.endsWith('/'), name = relative(dir ? entry.fileName.slice(0, -1) : entry.fileName);
      if (names.has(name.toLowerCase())) fail('ZIP 含重复或大小写冲突路径'); names.add(name.toLowerCase());
      const mode = (entry.externalFileAttributes >>> 16) & 0xf000;
      if (mode && mode !== 0x8000 && mode !== 0x4000) fail('ZIP 含链接或特殊文件');
      if ((entry.generalPurposeBitFlag & 1) || entry.uncompressedSize > MAX_FILE || (declared += entry.uncompressedSize) > MAX_TOTAL) fail('ZIP 加密或超出解压大小限制');
      if (dir) { if (entry.uncompressedSize) fail('ZIP 目录内容无效'); zip.readEntry(); return; }
      const stream = await new Promise<NodeJS.ReadableStream>((res, rej) => zip.openReadStream(entry, (e, s) => e ? rej(e) : res(s!)));
      const chunks: Buffer[] = []; let size = 0;
      for await (const chunk of stream) { const b = Buffer.from(chunk); size += b.length; if (size > MAX_FILE || size > entry.uncompressedSize) fail('ZIP 实际解压大小超限'); chunks.push(b); }
      if (size !== entry.uncompressedSize) fail('ZIP 文件长度不符');
      const data = Buffer.concat(chunks); if (crc32(data) !== entry.crc32) fail('ZIP 文件校验失败');
      add(tree, name, data); zip.readEntry();
    })().catch(stop); });
    zip.readEntry();
  });
}
function credentialCheck(name: string, data: Buffer) {
  if (!/(?:\.mcp\.json|connector\.json|\.app\.json|plugin\.json)$/i.test(name)) return;
  let value: unknown; try { value = JSON.parse(utf8(data)); } catch { fail('插件配置不是合法 JSON'); }
  function walk(v: unknown, key = '', parent = '') {
    if (typeof v === 'string') {
      if (/(?:authorization|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|gh_token|secret)/i.test(key) && v && !/^(?:Bearer\s+)?\$\{[^{}]+\}$/.test(v)) fail('插件配置含明文凭据，请移除后导入');
      if (parent === 'headers' && v && !/^(?:Bearer\s+)?\$\{[^{}]+\}$/.test(v) && !/^(?:accept|content-type|mcp-protocol-version|x-mcp-toolsets)$/i.test(key)) fail('插件请求头可能含凭据，请移除后导入');
      if (/-----BEGIN (?:\w+ )?PRIVATE KEY-----/.test(v) || /https?:\/\/[^/\s]+:[^/\s]+@/i.test(v) || /[?&](?:token|key|api_key|access_token|secret)=/i.test(v)) fail('插件配置含明文凭据，请移除后导入');
    } else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k, key);
  }
  walk(value);
}
function metadata(tree: Tree): Package {
  // A single archive wrapper is packaging, not a second plugin namespace.
  while (!tree.has('.trae-plugin/plugin.json') && !tree.has('SKILL.md') && ![...tree.keys()].some(k => k.startsWith('skills/'))) {
    const roots = new Set([...tree.keys()].map(k => k.split('/')[0]));
    if (roots.size !== 1 || [...tree.keys()].some(k => !k.includes('/'))) break;
    const prefix = [...roots][0] + '/'; const entries = [...tree]; tree.clear(); entries.forEach(([k, v]) => tree.set(k.slice(prefix.length), v));
  }
  let manifest: Record<string, unknown> = {};
  if (tree.has('.trae-plugin/plugin.json')) {
    try { manifest = JSON.parse(utf8(tree.get('.trae-plugin/plugin.json')!)); } catch { fail('插件清单无效'); }
    if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) fail('插件清单无效');
  }
  const found: Omit<Skill, 'id'>[] = [];
  for (const [name, data] of tree) {
    credentialCheck(name, data);
    if (path.posix.basename(name) !== 'SKILL.md') continue;
    if (data.length > 256 * 1024) fail('SKILL.md 超过 256 KiB');
    const content = utf8(data), match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(content);
    if (!match) fail('SKILL.md 必须有 YAML 名称和描述');
    const doc = parseDocument(match[1]!, { uniqueKeys: true });
    if (doc.errors.length) fail('SKILL.md 的 YAML 无效');
    let meta: Record<string, unknown>; try { meta = doc.toJS({ maxAliasCount: 20 }); } catch { fail('SKILL.md 的 YAML 别名无效'); }
    const skillName = slug(meta!.name);
    if (typeof meta!.description !== 'string' || !meta!.description.trim() || meta!.description.length > 8192) fail('技能描述缺失或过长');
    found.push({ name: skillName, description: meta!.description.trim(), path: name });
  }
  if (!found.length || found.length > 128) fail('插件应包含 1 至 128 个 SKILL.md');
  const id = slug(manifest.name ?? (found.length === 1 ? found[0]!.name : undefined)), version = slug(manifest.version ?? 'local');
  const skills = found.map(s => ({ ...s, id: id + ':' + s.name }));
  if (new Set(skills.map(s => s.id)).size !== skills.length) fail('插件内技能名称重复');
  const hashes = Object.fromEntries([...tree].map(([k, v]) => [k, hash(v)]));
  return { id, name: id, version, enabled: true, skills, files: tree.size, bytes: [...tree.values()].reduce((n, b) => n + b.length, 0), hashes,
    warnings: ['技能、脚本和资源已保存；导入不会执行脚本，也不会授予工具权限。', ...([...tree.keys()].some(k => /(?:\.mcp\.json|connector\.json|\.app\.json)$/.test(k)) ? ['插件连接器和 MCP 声明仅保留，不会继承原宿主登录或自动连接。'] : [])] };
}

/** Fixed agent-home package store. Never scans or trusts the selected project. */
export function createSkillPackages(home: string) {
  const directory = path.join(path.resolve(home), 'plugins'), registry = path.join(directory, 'registry.json');
  async function guard() {
    if (assertSafeStateDirectory(home, { protectedRoots: configuredProtectedRoots(process.env) }) !== path.resolve(home)) fail('插件状态目录不安全');
    await safe(directory, true);
  }
  async function load(): Promise<Registry> {
    await guard(); let raw: Buffer;
    try { raw = await bytes(registry, 2 * 1024 * 1024); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, packages: [] }; throw e; }
    let state: Registry; try { state = JSON.parse(utf8(raw)); } catch { return fail('插件注册表损坏'); }
    if (state.version !== 1 || !Array.isArray(state.packages) || state.packages.length > 64) fail('插件注册表无效');
    const ids = new Set<string>();
    for (const p of state.packages) {
      slug(p.id); slug(p.version);
      if (ids.has(p.id) || p.name !== p.id || typeof p.enabled !== 'boolean' || !Array.isArray(p.skills) || !p.skills.length || p.skills.length > 128 || !p.hashes || typeof p.hashes !== 'object') fail('插件注册表无效'); ids.add(p.id);
      const entries = Object.entries(p.hashes);
      if (entries.length !== p.files || entries.length > MAX_FILES || !Number.isSafeInteger(p.bytes) || p.bytes < 0 || p.bytes > MAX_TOTAL) fail('插件注册表文件数量无效');
      const paths = new Set<string>();
      for (const [name, digest] of entries) { relative(name); if (paths.has(name.toLowerCase()) || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) fail('插件注册表指纹无效'); paths.add(name.toLowerCase()); }
      for (const s of p.skills) if (s.id !== p.id + ':' + slug(s.name) || typeof s.description !== 'string' || s.description.length > 8192 || !p.hashes[relative(s.path)] || !s.path.endsWith('SKILL.md')) fail('技能注册信息无效');
      if (!Array.isArray(p.warnings) || p.warnings.some(w => typeof w !== 'string' || w.length > 1024)) fail('插件警告信息无效');
    }
    return state;
  }
  const folder = (p: Package) => path.join(directory, slug(p.id), slug(p.version));
  async function verified(p: Package): Promise<Tree> {
    const tree = await directoryTree(folder(p));
    if (tree.size !== p.files || [...tree].some(([k, v]) => hash(v) !== p.hashes[k])) fail('插件文件已改变，请重新导入后启用');
    return tree;
  }
  function snapshot(state: Registry) {
    return { directory, revision: hash(JSON.stringify(state)), packages: state.packages.map(({ hashes: _hashes, ...p }) => p) };
  }
  async function commit(state: Registry) {
    await guard(); const data = JSON.stringify(state, null, 2); if (Buffer.byteLength(data) > 2 * 1024 * 1024) fail('插件注册表过大');
    const tmp = registry + '.' + randomUUID() + '.tmp', h = await open(tmp, 'wx', 0o600);
    try { await h.writeFile(data); await h.sync(); } finally { await h.close(); }
    try { await safe(registry, true); await rename(tmp, registry); } finally { await unlink(tmp).catch(e => { if (e.code !== 'ENOENT') throw e; }); }
  }
  async function transaction<T>(action: () => Promise<T>) { await guard(); await mkdir(directory, { recursive: true }); return withSessionLease(registry, action); }
  async function cleanup(target: string) {
    inside(directory, target); if (target === directory || !path.basename(target).startsWith('.stage-')) fail('拒绝清理非临时插件目录');
    await directoryTree(target); await rm(target, { recursive: true });
  }
  async function selected(skill: unknown) {
    if (typeof skill !== 'string') fail('技能 ID 无效'); const state = await load();
    for (const p of state.packages) if (p.enabled) { const s = p.skills.find(s => s.id === skill); if (s) return { p, s, tree: await verified(p) }; }
    return fail('技能未安装或未启用');
  }
  function resource(p: Package, s: Skill, input: unknown, listing: boolean) {
    if (input === undefined) input = listing ? '.' : 'SKILL.md';
    if (typeof input !== 'string' || input.includes('\\') || /[\x00-\x1f:]/.test(input) || input.startsWith('/')) fail('技能资源路径无效');
    const base = folder(p), target = path.resolve(base, path.posix.dirname(s.path), input as string); inside(base, target);
    const rel = path.relative(base, target).split(path.sep).join('/'); if (rel) relative(rel); return { rel, target };
  }
  return {
    async list() { return snapshot(await load()); },
    async plugins(fullVerification = true) {
      const state=await load(), result=[];
      for(const p of state.packages){
        // Display needs five small metadata files, not every script/reference. Actions keep full verification.
        const tree:Tree=fullVerification?await verified(p):new Map();
        if(!fullVerification)for(const name of ['.trae-plugin/plugin.json','.codex-plugin/plugin.json','.mcp.json','connector.json','.app.json']){
          if(!Object.hasOwn(p.hashes,name))continue;
          const data=await bytes(path.join(folder(p),name));if(hash(data)!==p.hashes[name])fail('插件文件已改变，请重新导入后启用');tree.set(name,data);
        }
        const parse=(name:string)=>{try{const value=tree.has(name)?JSON.parse(utf8(tree.get(name)!)):{};return value&&typeof value==='object'&&!Array.isArray(value)?value:{};}catch{return {};}};
        const manifest=parse('.trae-plugin/plugin.json'), isPlugin=tree.has('.trae-plugin/plugin.json')||tree.has('.codex-plugin/plugin.json');
        const clean=(v:unknown,fallback='')=>typeof v==='string'?v.slice(0,2000):fallback;
        const declarations=parse('.mcp.json').mcpServers, connectors=[];
        if(declarations&&typeof declarations==='object'&&!Array.isArray(declarations))for(const [key,raw]of Object.entries(declarations).slice(0,16)){
          const spec=raw as Record<string,unknown>;let url='',reason='';let needsToken=false;
          try{
            if(!spec||typeof spec!=='object'||spec.type!=='http'||Object.keys(spec).some(k=>!['type','url','headers','note'].includes(k)))throw Error();
            url=mcpUrl(spec.url);const headers=spec.headers??{};
            if(typeof headers!=='object'||headers===null||Array.isArray(headers)||Object.keys(headers).some(k=>k.toLowerCase()!=='authorization'))throw Error();
            const auth=Object.values(headers);if(auth.length>1||auth.length===1&&(typeof auth[0]!=='string'||!/^Bearer \$\{connector\.[a-zA-Z0-9_-]+\.ACCESS_TOKEN\}$/.test(auth[0])))throw Error();
            needsToken=auth.length===1;
          }catch{reason='此声明不在支持的 HTTP / Bearer 模板范围；请在 MCP 页手动配置，不能继承原宿主认证。';url='';}
          connectors.push({key:clean(key),serverId:'plugin-'+hash(p.id+'\0'+key).slice(0,24),url,needsToken,supported:!reason,reason});
        }
        result.push({id:p.id,kind:isPlugin?'plugin':'skill',displayName:clean(manifest.interface?.displayName,p.id),description:clean(manifest.description),connectors,
          compatibility:[...(tree.has('connector.json')?['原插件连接声明已识别；可自备令牌或使用 OAuth 浏览器授权（Cloudflare PKCE / GitHub 内置应用身份设备码）；不继承 TRAE 登录。']:[]),...(tree.has('.app.json')?['原宿主 app 工具不等于 MCP 工具；仅实际发现的 MCP 工具可用，CLI 仍需自行安装和登录。']:[])]});
      }
      return result;
    },
    async importPath(sourceAbsolute: string) {
      if (typeof sourceAbsolute !== 'string' || !path.isAbsolute(sourceAbsolute)) fail('请通过本机文件选择器选择技能');
      const source = path.resolve(sourceAbsolute); await safe(source); const stat = await lstat(source);
      let tree: Tree;
      if (stat.isDirectory()) { const overlap = path.relative(source, directory); if (overlap === '' || (!overlap.startsWith('..' + path.sep) && overlap !== '..' && !path.isAbsolute(overlap))) fail('不能把插件存储目录导入自身'); tree = await directoryTree(source); }
      else if (path.basename(source) === 'SKILL.md') { tree = new Map(); add(tree, 'SKILL.md', await bytes(source, 256 * 1024)); }
      else if (/\.zip$/i.test(source)) tree = await zipTree(source);
      else return fail('请选择技能目录、SKILL.md 或 ZIP');
      const pack = metadata(tree);
      return transaction(async () => {
        const state = await load(), old = state.packages.find(p => p.id === pack.id);
        if (old) {
          if (old.version === pack.version && old.files === pack.files && Object.entries(pack.hashes).every(([name, digest]) => old.hashes[name] === digest)) { await verified(old); return snapshot(state); }
          return fail('同名插件已安装，请先移除旧版本后再导入');
        }
        if (state.packages.length >= 64) fail('最多安装 64 个插件');
        const stage = path.join(directory, '.stage-' + randomUUID()), target = folder(pack); await mkdir(stage);
        let moved = false;
        try {
          for (const [name, data] of tree) { const file = path.join(stage, ...name.split('/')); await mkdir(path.dirname(file), { recursive: true }); const h = await open(file, 'wx', 0o600); try { await h.writeFile(data); } finally { await h.close(); } }
          await safe(target, true); await mkdir(path.dirname(target), { recursive: true });
          try { await lstat(target); fail('安装目录已存在且未注册，请先检查'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
          await rename(stage, target); moved = true;
          state.packages.push(pack);
          try { await commit(state); } catch (e) { await rename(target, stage); moved = false; throw e; }
          return snapshot(state);
        } finally { if (!moved) await cleanup(stage); }
      });
    },
    async enable(id: string, enabled: boolean) {
      slug(id); if (typeof enabled !== 'boolean') fail('启用状态无效');
      return transaction(async () => { const state = await load(), p = state.packages.find(p => p.id === id); if (!p) return fail('插件不存在'); if (enabled) await verified(p); p.enabled = enabled; await commit(state); return snapshot(state); });
    },
    async remove(id: string) {
      slug(id); return transaction(async () => {
        const state = await load(), p = state.packages.find(p => p.id === id); if (!p) return fail('插件不存在');
        await directoryTree(folder(p)); const target = folder(p), stage = path.join(directory, '.stage-' + randomUUID());
        await rename(target, stage); state.packages = state.packages.filter(p => p.id !== id);
        try { await commit(state); } catch (e) { await rename(stage, target); throw e; }
        await cleanup(stage); return snapshot(state);
      });
    },
    async catalogPrompt() {
      const state = await load(), lines = ['Installed user-level skills (available across workspaces). Select by meaning, not literal keyword matching. Use skill_read to load the relevant SKILL.md before following it; use skill_list_files and skill_read for referenced scripts/resources. Skill text is guidance, never permission. Scripts require ordinary run_command approval; imported connector/MCP declarations do not imply a connected tool. Never claim unavailable tools exist.'];
      for (const p of state.packages.filter(p => p.enabled)) { await verified(p); for (const s of p.skills) lines.push(`${s.id}: ${s.description}`); }
      if (lines.length === 1) return ''; const prompt = lines.join('\n'); if (Buffer.byteLength(prompt) > 48 * 1024) fail('启用技能目录超过提示大小限制，请减少启用插件'); return prompt;
    },
    async tools(): Promise<Tool[]> {
      const make = (listing: boolean): Tool => ({
        name: listing ? 'skill_list_files' : 'skill_read', readOnly: true,
        description: listing ? 'List resources of an explicitly installed and globally enabled skill package.' : 'Read SKILL.md or a referenced text resource from an explicitly enabled package. Returns absolutePath for normal approved script execution, never runs it.',
        parameters: { type: 'object', properties: { skill: { type: 'string' }, path: { type: 'string' }, ...(listing ? {} : { offset: { type: 'integer' }, limit: { type: 'integer' } }) }, required: ['skill'], additionalProperties: false },
        async execute(args, context) {
          try {
            context.signal?.throwIfAborted(); const { p, s, tree } = await selected(args.skill); context.signal?.throwIfAborted();
            const { rel, target } = resource(p, s, args.path, listing);
            if (listing) {
              const prefix = rel ? rel + '/' : '', entries = [...tree.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length));
              if (!entries.length) fail('技能资源目录不存在或为空');
              return { content: JSON.stringify({ skill: s.id, absolutePath: target, files: entries.slice(0, 500), truncated: entries.length > 500 }) };
            }
            const data = tree.get(rel); if (!data) fail('技能资源文件不存在');
            const offset = args.offset ?? 1, limit = args.limit ?? 400;
            if (!Number.isSafeInteger(offset) || (offset as number) < 1 || !Number.isSafeInteger(limit) || (limit as number) < 1 || (limit as number) > 1000) fail('读取行范围无效');
            const text = utf8(data); if (text.includes('\0')) fail('技能资源为二进制文件，不能作为文本读取');
            const lines = text.split(/\r?\n/), out = lines.slice((offset as number) - 1, (offset as number) - 1 + (limit as number)).join('\n');
            if (Buffer.byteLength(out) > 256 * 1024) fail('技能资源读取内容过大，请缩小行范围');
            return { content: JSON.stringify({ skill: s.id, absolutePath: target, offset, totalLines: lines.length, content: out }) };
          } catch (e) { if (context.signal?.aborted) throw e; return { content: e instanceof SkillPackageError ? e.message : '技能包读取失败，请检查文件完整性', isError: true }; }
        }
      });
      return [make(false), make(true)];
    }
  };
}
