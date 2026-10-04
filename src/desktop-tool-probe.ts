import { createOpenAIChatAdapter } from './openai-adapter.ts';

/** One synthetic request; never executes tools or uploads workspace/history. */
export async function probeDesktopTools(config: {baseUrl:string; model:string; apiKey:string}, fetchImpl: typeof fetch = fetch) {
  const adapter = createOpenAIChatAdapter({...config, maxTokens:512, timeoutMs:30000,
    fetchImpl:(url,init)=>fetchImpl(url,{...init,redirect:'error'})});
  try {
    const result = await adapter.chat({messages:[{role:'user',content:'Protocol diagnostic only. Call list_directory with path=".". This is a synthetic fixture, not a real directory. Do not invent other tools.'}],
      tools:[{name:'list_directory',description:'List synthetic fixture files; no real filesystem access.',parameters:{type:'object',properties:{path:{type:'string'}},required:['path'],additionalProperties:false}}]});
    const calls = result.toolCalls ?? [];
    const compatible = calls.some(c=>{try{return c.name==='list_directory'&&JSON.parse(c.arguments).path==='.';}catch{return false;}});
    return {compatible, offered:['list_directory'], returned:calls.map(c=>c.name),
      detail:compatible?'接口返回了正确的结构化工具调用（未执行）。':'本次没有返回所声明的结构化工具调用；文字聊天成功不代表工具兼容。单次探测不能断言永久不支持。',
      response:result.content.replaceAll(config.apiKey,'[REDACTED]').slice(0,1200)};
  } catch { return {compatible:false,offered:['list_directory'],returned:[],detail:'探测请求失败或响应协议异常；无法判定工具能力。未读取工作区，也未执行工具。',response:''}; }
}
