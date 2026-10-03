import { lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { providerConfig } from './cli-config.ts';
import { assertSafeStateDirectory, canonicalPath, configuredProtectedRoots } from './security-config.ts';
import { readBoundedUtf8 } from './bounded-read.ts';

export const presets = [
  { id: 'deepseek', name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1' },
  { id: 'openai', name: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  { id: 'kimi', name: 'Kimi', baseUrl: 'https://api.moonshot.cn/v1' },
];
export interface SecretStorage { isEncryptionAvailable(): boolean; encryptString(v: string): Buffer; decryptString(v: Buffer): string; getSelectedStorageBackend?(): string; }
export class ProviderError extends Error {}
const fail = (s: string): never => { throw new ProviderError(s); };
interface Profile { id: string; name: string; kind: string; baseUrl: string; protocol: string; models: string[]; secret: string; }
interface State { v: number; revision: string; providers: Profile[]; }
const MAX = 256 * 1024;
function text(v: unknown, label: string, max = 256): string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || /[\x00-\x1f\x7f]/.test(v)) fail(label + '无效');
  return (v as string).trim();
}
function object(v: unknown): Record<string, any> {
  if (!v || typeof v !== 'object' || Array.isArray(v)) fail('配置格式无效');
  return v as Record<string, any>;
}
function fields(v: unknown) {
  const p = object(v), id = text(p.id, 'Provider ID', 64);
  if (!/^[a-z][a-z0-9-]*$/.test(id)) fail('Provider ID 须为小写字母开头，仅含字母、数字、短横线');
  if (p.protocol !== 'openai-chat') fail('当前仅支持 OpenAI Chat Completions 协议');
  if (p.kind !== 'custom' && !presets.some(x => x.id === p.kind)) fail('提供商类型无效');
  const baseUrl = text(p.baseUrl, 'API 地址', 2048);
  let valid;
  try { valid = providerConfig({ baseUrl, model: 'validation', apiKey: 'validation' }); }
  catch { return fail('API 地址须为 HTTPS；HTTP 仅限 localhost/127.0.0.1，不允许账号或查询参数'); }
  if (!Array.isArray(p.models) || p.models.length > 500) fail('模型目录最多 500 项');
  const models: string[] = [...new Set<string>(p.models.map((m: unknown) => text(m, '模型 ID')))];
  return { id, name: text(p.name, '显示名称', 80), kind: p.kind as string, baseUrl: valid.baseUrl, protocol: 'openai-chat', models };
}
export class DesktopProviders {
  private home: string;
  private crypto: SecretStorage;
  constructor(home: string, crypto: SecretStorage) { this.home = home; this.crypto = crypto; }
  private file() {
    const root = assertSafeStateDirectory(this.home, { protectedRoots: configuredProtectedRoots(process.env) });
    if (root !== path.resolve(this.home)) fail('配置目录不能是链接');
    return path.join(root, 'desktop-providers.json');
  }
  private secure() {
    if (!this.crypto.isEncryptionAvailable() || this.crypto.getSelectedStorageBackend?.() === 'basic_text') fail('系统密钥加密不可用，拒绝明文保存');
  }
  private async check(file: string) {
    if (canonicalPath(file) !== file) fail('配置路径不能是链接');
    try { const s = await lstat(file); if (!s.isFile() || s.isSymbolicLink() || s.nlink !== 1 || s.size > MAX) fail('配置文件不安全或超过 256 KiB'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  private async read(): Promise<State> {
    const file = this.file(); await this.check(file);
    let h;
    try { h = await open(file, 'r'); }
    catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { v: 1, revision: 'empty', providers: [] }; throw e; }
    try {
      const s = await h.stat(); if (!s.isFile() || s.nlink !== 1 || s.size > MAX) fail('配置文件不安全');
      const bytes = Buffer.alloc(MAX + 1); let size = 0, n;
      do { n = (await h.read(bytes, size, bytes.length - size, null)).bytesRead; size += n; } while (n && size < bytes.length);
      if (size > MAX) fail('配置超过 256 KiB');
      const state = object(JSON.parse(bytes.subarray(0, size).toString('utf8')));
      if (state.v !== 1 || typeof state.revision !== 'string' || !Array.isArray(state.providers) || state.providers.length > 32) fail('配置版本或内容无效');
      const providers = state.providers.map((raw: unknown) => {
        const p = object(raw), meta = fields(p);
        if (typeof p.secret !== 'string' || p.secret.length > 24000) fail('加密密钥无效');
        return { ...meta, secret: p.secret };
      });
      if (new Set(providers.map((p: Profile) => p.id)).size !== providers.length) fail('配置包含重复 ID');
      return { v: 1, revision: state.revision, providers };
    } finally { await h.close(); }
  }
  async list() {
    const s = await this.read();
    return { revision: s.revision, presets, providers: s.providers.map(({ secret, ...p }) => ({ ...p, hasKey: !!secret })) };
  }
  private async draft(payload: unknown) {
    const data = object(payload), state = await this.read();
    if (data.revision !== state.revision) fail('配置已变化，请关闭后重新打开设置');
    const p = object(data.provider), meta = fields(p), old = state.providers.find(x => x.id === meta.id);
    if (data.editingId !== undefined && (data.editingId !== meta.id || !old)) fail('编辑目标已不存在或 ID 已改变');
    if (data.editingId === undefined && old) fail('Provider ID 已存在，请使用编辑而不是重复创建');
    if (typeof p.apiKey !== 'string' || Buffer.byteLength(p.apiKey) > 8192 || /[\x00-\x1f\x7f]/.test(p.apiKey)) fail('API 密钥无效');
    let apiKey = p.apiKey.trim();
    if (!apiKey && old?.secret) {
      if (old.baseUrl !== meta.baseUrl || old.kind !== meta.kind || old.protocol !== meta.protocol) fail('地址或提供商类型已改变，请重新输入密钥');
      this.secure(); apiKey = this.crypto.decryptString(Buffer.from(old.secret, 'base64'));
    }
    return { state, meta, apiKey };
  }
  private async mutate(revision: unknown, change: (s: State) => State) {
    const file = this.file(); await mkdir(path.dirname(file), { recursive: true });
    const lockPath = file + '.lock'; let lock;
    try { lock = await open(lockPath, 'wx', 0o600); }
    catch { return fail('配置正在修改或锁未清理，请稍后重试；不要直接删除未知锁'); }
    const temp = file + '.' + randomUUID() + '.tmp'; let created = false;
    try {
      const state = await this.read(); if (state.revision !== revision) fail('配置已变化，请重新打开设置');
      const next = change(state); next.revision = randomUUID();
      if (next.providers.length > 32) fail('最多保存 32 个提供商');
      const data = JSON.stringify(next, null, 2); if (Buffer.byteLength(data) > MAX) fail('配置超过 256 KiB');
      const h = await open(temp, 'wx', 0o600); created = true;
      try { await h.writeFile(data); await h.sync(); } finally { await h.close(); }
      await this.check(file); this.file(); await rename(temp, file); created = false;
    } finally {
      // Only unlink our exact, exclusively created temp/lock paths, never renderer paths.
      if (created) await unlink(temp);
      await lock.close(); await unlink(lockPath);
    }
    return this.list();
  }
  async save(payload: unknown) {
    const { state, meta, apiKey } = await this.draft(payload); this.secure();
    const secret = apiKey ? this.crypto.encryptString(apiKey).toString('base64') : '';
    return this.mutate(state.revision, s => ({ ...s, providers: [...s.providers.filter(p => p.id !== meta.id), { ...meta, secret }] }));
  }
  async delete(payload: unknown) {
    const p = object(payload), id = text(p.id, 'Provider ID', 64);
    return this.mutate(p.revision, s => ({ ...s, providers: s.providers.filter(x => x.id !== id) }));
  }
  async discover(payload: unknown) {
    const { meta, apiKey } = await this.draft(payload);
    let response;
    try { response = await fetch(meta.baseUrl + '/models', { headers: apiKey ? { authorization: 'Bearer ' + apiKey } : {}, redirect: 'error', signal: AbortSignal.timeout(15000) }); }
    catch { return fail('无法获取模型：连接失败、超时或发生重定向，请检查地址与网络'); }
    if (!response.ok) {
      await response.body?.cancel();
      return fail(response.status === 401 || response.status === 403 ? '认证失败，请检查 API 密钥和模型权限' : `获取模型失败（HTTP ${response.status}）；上游可能不支持模型列表，请手动添加`);
    }
    try {
      const data = object(JSON.parse(response.body ? await readBoundedUtf8(response.body, MAX, 'models') : ''));
      if (!Array.isArray(data.data) || data.data.length > 500) fail('模型列表格式不支持或超过 500 项');
      return { models: [...new Set<string>(data.data.map((m: unknown) => text(object(m).id, '模型 ID')))] };
    } catch { return fail('上游模型列表格式不支持、超时或超过限制；可手动添加模型 ID'); }
  }
  async resolve(id: unknown, model: unknown, revision?: unknown) {
    const state = await this.read();
    if (revision !== undefined && revision !== state.revision) fail('配置已变化，请重新确认');
    const p = state.providers.find(x => x.id === id);
    if (!p || typeof model !== 'string' || !p.models.includes(model)) throw new ProviderError('请选择已保存的提供商与模型');
    this.secure();
    return { baseUrl: p.baseUrl, model, apiKey: p.secret ? this.crypto.decryptString(Buffer.from(p.secret, 'base64')) : '', revision: state.revision };
  }
}
