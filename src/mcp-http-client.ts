import type { McpClient } from './mcp-client.ts';

export type McpTransport = Pick<McpClient, 'request'|'initialize'|'closeAndWait'|'closed'>;
export class McpConfigError extends Error {}
export function mcpUrl(value: unknown): string {
  if (typeof value !== 'string' || value.length > 2048) throw new McpConfigError('MCP URL 无效');
  let url: URL; try { url = new URL(value); } catch { throw new McpConfigError('MCP URL 无效'); }
  if (url.username || url.password || url.search || url.hash || !(url.protocol === 'https:' || url.protocol === 'http:' && ['localhost','127.0.0.1','[::1]'].includes(url.hostname))) throw new McpConfigError('MCP 使用 HTTPS（本机回环允许 HTTP），URL 不得包含凭据、查询或片段');
  return url.href;
}
const MAX = 1024 * 1024;
const VERSIONS = ['2025-06-18','2025-03-26','2024-11-05'];
/** Streamable HTTP: one bounded POST per request; no retry or redirect of side effects. */
export class McpHttpClient implements McpTransport {
  private url: string;
  private headers: Record<string,string>;
  private timeout: number;
  private sequence = 0;
  private session?: string;
  private version = VERSIONS[0]!;
  private ended = false;
  private active = new Map<AbortController,Promise<unknown>>();
  private closing?: Promise<void>;
  constructor(url: string, headers: Record<string,string> = {}, timeout = 30000) {
    this.url = mcpUrl(url); this.headers = {...headers}; this.timeout = timeout;
  }
  get closed() { return this.ended; }
  private async post(message: Record<string,unknown>, notification = false): Promise<unknown> {
    if (this.ended) throw Error('MCP 连接已关闭');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    const work = (async () => {
      const response = await fetch(this.url,{method:'POST',redirect:'error',signal:controller.signal,
        headers:{...this.headers,'Content-Type':'application/json',Accept:'application/json, text/event-stream','MCP-Protocol-Version':this.version,...(this.session?{'Mcp-Session-Id':this.session}:{})},body:JSON.stringify(message)});
      if (!response.ok) { await response.body?.cancel(); throw Error(`MCP HTTP ${response.status}`); }
      const session = response.headers.get('mcp-session-id');
      if (session) {
        if (!/^[\x21-\x7e]{1,256}$/.test(session) || this.session && this.session !== session) { await response.body?.cancel(); throw Error('MCP 会话标识无效'); }
        this.session = session;
      }
      if (notification) { await response.body?.cancel(); return undefined; }
      if (!response.body) throw Error('MCP 响应为空');
      const reader = response.body.getReader(), decoder = new TextDecoder('utf-8',{fatal:true});
      const mime = response.headers.get('content-type')?.split(';')[0]?.trim();
      if (mime !== 'application/json' && mime !== 'text/event-stream') { await reader.cancel(); throw Error('MCP 响应格式无效'); }
      let bytes = 0, buffer = '';
      const decode = (raw: string): {matched:boolean; result?:unknown} => {
        let item: Record<string,unknown>; try { item = JSON.parse(raw); } catch { throw Error('MCP JSON 响应无效'); }
        if (!item || typeof item !== 'object' || Array.isArray(item) || item.jsonrpc !== '2.0') throw Error('MCP JSON-RPC 响应无效');
        if ('method' in item) {
          if ('id' in item) throw Error('不支持 MCP 服务器发起的请求');
          return {matched:false};
        }
        if (item.id !== message.id) throw Error('MCP 响应 ID 不匹配');
        if ('error' in item) throw Error('MCP 服务器返回调用错误'); // Never forward a server's potential credential echo.
        if (!('result' in item)) throw Error('MCP 响应缺少结果');
        return {matched:true,result:item.result};
      };
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) { buffer += decoder.decode(); break; }
          bytes += chunk.value.length; if (bytes > MAX) throw Error('MCP 响应超过 1 MiB');
          buffer += decoder.decode(chunk.value,{stream:true});
          if (mime === 'text/event-stream') {
            buffer = buffer.replace(/\r\n/g,'\n');
            let separator: number;
            while ((separator = buffer.indexOf('\n\n')) >= 0) {
              const event = buffer.slice(0,separator); buffer = buffer.slice(separator+2);
              const data = event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');
              if (!data) continue;
              const parsed = decode(data); if (parsed.matched) return parsed.result;
            }
          }
        }
        if (mime !== 'application/json') throw Error('MCP SSE 在结果完成前结束');
        const parsed = decode(buffer); if (!parsed.matched) throw Error('MCP 响应缺少调用结果'); return parsed.result;
      } finally { await reader.cancel().catch(()=>{}); }
    })();
    this.active.set(controller,work);
    try { return await work; }
    catch (error) { if (error instanceof Error && /^MCP |^不支持 MCP /.test(error.message)) throw error; throw Error(controller.signal.aborted?'MCP 请求已取消或超时':'MCP 网络请求失败'); }
    finally { clearTimeout(timer); this.active.delete(controller); }
  }
  request(method: string, params?: Record<string,unknown>): Promise<unknown> {
    return this.post({jsonrpc:'2.0',id:++this.sequence,method,...(params?{params}:{})});
  }
  async initialize(clientName = 'personal-agent-desktop') {
    const result = await this.request('initialize',{protocolVersion:this.version,capabilities:{},clientInfo:{name:clientName,version:'0.1.0'}}) as Awaited<ReturnType<McpClient['initialize']>>;
    if (!result || typeof result.protocolVersion !== 'string' || !VERSIONS.includes(result.protocolVersion)) throw Error('MCP 协议版本不支持');
    this.version = result.protocolVersion;
    await this.post({jsonrpc:'2.0',method:'notifications/initialized'},true);
    return result;
  }
  closeAndWait(): Promise<void> {
    this.ended = true;
    return this.closing ??= (async()=>{
      const pending = [...this.active.entries()]; pending.forEach(([controller])=>controller.abort());
      await Promise.allSettled(pending.map(([,work])=>work));
      if (this.session) {
        try { const response = await fetch(this.url,{method:'DELETE',redirect:'error',signal:AbortSignal.timeout(2000),headers:{...this.headers,'Mcp-Session-Id':this.session,'MCP-Protocol-Version':this.version}}); await response.body?.cancel(); } catch { /* Local requests are closed; remote session expiry remains server-owned. */ }
      }
      this.headers = {}; this.session = undefined;
    })();
  }
}
