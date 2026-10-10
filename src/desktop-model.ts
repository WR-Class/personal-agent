import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDesktopMemory } from './desktop-memory.ts';
import { CycleStore } from './cycle-store.ts';
import { GeneStore } from './gene-store.ts';
import { desktopOutputTokens } from './desktop-providers.ts';
import { loadProvider } from './cli-config.ts';
import { createOpenAIChatAdapter, incompleteReply, type StreamProgress } from './openai-adapter.ts';
import { looksLikeAccountProblem } from './preflight.ts';
import { AgentRuntime } from './runtime.ts';
import { SessionStore } from './session-store.ts';
import type { SessionEvent } from './session-store.ts';
import { createDesktopTools } from './desktop-tools.ts';
import type { DesktopToolOptions } from './desktop-tools.ts';
import { desktopUsageSummary, type DesktopUsageSummary } from './desktop-usage.ts';
import { ToolRegistry, type Tool } from './tools.ts';
import type { TaskPromptSkill } from './taskspec-prompt.ts';
import { RULE_TIERS } from './rule-table.ts';
import { PLAN_TOOLS, TASK_TOOLS } from './desktop-task-flow.ts';

export interface DesktopExtensions { onStream?:(event:{responseId:string;text:string;start?:boolean;progress?:StreamProgress;complete?:boolean;retry?:{attempt:number;delayMs:number;reason?:'length'|'transport'};reasoning?:string;tool?:{index:number;name:string;argumentChars:number}})=>void; skills: readonly TaskPromptSkill[]; tools: readonly Tool[]; skillTools?: readonly Tool[]; skillCatalog?: string; hostTools?: readonly Tool[]; taskGuidance?:string; planning?:boolean; beforeTool?:(name:string)=>void; }

export type DesktopToolTranscript =
  | { kind: 'call'; callId: string; name: string; arguments: string }
  | { kind: 'result'; callId: string; name: string; content: string; isError: boolean };
export interface DesktopModelResult {
  id: string;
  content: string;
  model: string;
  transcript?: DesktopToolTranscript[];
  error?: string;
  recoveredTools?: number;
  toolStatus?: { offered: string[]; requested: number; completed: number; failed: number };
  usageSummary: DesktopUsageSummary;
}
function transcript(events: SessionEvent[]): DesktopToolTranscript[] {
  const names = new Map<string, string>();
  const result: DesktopToolTranscript[] = [];
  for (const event of events) {
    if (event.kind !== 'message') continue;
    for (const call of event.message.toolCalls ?? []) {
      names.set(call.id, call.name);
      result.push({ kind: 'call', callId: call.id, name: call.name, arguments: call.arguments });
    }
    if (event.message.role === 'tool' && event.message.toolCallId) {
      const callId = event.message.toolCallId;
      result.push({ kind: 'result', callId, name: names.get(callId) ?? 'unknown', content: event.message.content, isError: event.isError === true });
    }
  }
  return result;
}

// Only classify known local errors; never expose raw provider bodies, keys or URLs.
function failureReason(error: unknown, stopped: boolean): string {
  const name = error instanceof Error ? error.name : '';
  const message = error instanceof Error ? error.message : '';
  if (stopped) return '请求已停止';
  if(name==='FirstDataTimeoutError')return '等待模型首个响应数据超过180秒（含响应头等待）';
  if(name==='StreamIdleTimeoutError')return '模型响应连续90秒没有新数据，已停止等待';
  if (name === 'DeadlineExceededError' || name === 'TimeoutError' || name === 'AbortError') return '模型请求超时';
  if (name === 'StepLimitError') return '已达到本轮模型往返次数上限，尚未收到最终答复（不代表已完成的文件操作失败）';
  if (name === 'ToolBudgetError') return '已达到本轮工具调用次数上限，已完成的操作保留';
  if (name === 'ContextBudgetError' || name === 'TokenBudgetError') return '本轮上下文超过限制';
  const http = /^model request failed: HTTP (\d{3})(?:\s|$)/.exec(message);
  if (http) return `模型服务请求失败（HTTP ${http[1]}）`;
  if (message.startsWith('model response incomplete: length')) return '模型回复达到输出长度限制，未完成；被截断回复中的工具调用未执行。本项目实测思考与正文共享同一个输出预算，请提高该模型的单次输出上限、在设置里为它关闭思考，或让模型分步骤、分文件处理';
  if (/^(invalid model response|model returned|model response incomplete|model stream ended)/.test(message)) return '模型服务返回了无效或不完整的回复';
  const size=/^model response exceeds the (\d+)-byte limit$/.exec(message);
  if(size)return `模型响应传输大小超过客户端 ${Number(size[1])/1024/1024} MiB 安全上限（不是 token 上限）；未完成回复中的工具调用未执行`;
  if(name==='TypeError'&&message==='terminated')return '模型服务连接在接收正文时中断；未收到完整回复（请检查网关或上游连接）';
  if (name === 'TypeError' && message === 'fetch failed') return '无法连接模型服务';
  return '本轮执行中断，未取得完整模型回复';
}

export async function desktopProvider(home: string, env: NodeJS.ProcessEnv = process.env) {
  const config = await loadProvider(home, env);
  if (!config || config.apiKey === '__ASK_AT_START__') throw new Error('complete provider configuration required');
  return { baseUrl: config.baseUrl, model: config.model };
}

export async function desktopModelSend(home: string, input: unknown, expected: { baseUrl: string; model: string }, env: NodeJS.ProcessEnv = process.env, selected?: { baseUrl: string; model: string; apiKey: string; maxTokens?: number; thinkingDisabled?: boolean }, sessionId?: string, options?: DesktopToolOptions & {remoteOnly?:boolean}, signal?: AbortSignal, extensions?: DesktopExtensions): Promise<DesktopModelResult> {
  if (typeof input !== 'string' || !input.trim() || Buffer.byteLength(input) > 8192) throw new Error('invalid input');
  const config = selected ?? await loadProvider(home, env);
  if (!config || config.apiKey === '__ASK_AT_START__' || !expected || config.baseUrl !== expected.baseUrl || config.model !== expected.model) throw new Error('provider changed or unavailable');
  const maxTokens = desktopOutputTokens(selected?.maxTokens);
  // sessionId is supplied only by the trusted host's per-window conversation state.
  if (sessionId !== undefined && !/^desktop-chat-[0-9a-f-]{36}$/.test(sessionId)) throw new Error('invalid desktop session');
  const id = sessionId ?? `desktop-model-${randomUUID()}`;
  const store = new SessionStore({ root: home, maxReadBytes: 1024 * 1024 });
  const runSignal = signal && options?.signal ? AbortSignal.any([signal, options.signal]) : signal ?? options?.signal;
  if(options&&extensions?.planning)options={...options,permission:'read'};
  const capability:ReturnType<typeof createDesktopTools>|undefined = options ? (options.remoteOnly?{tools:new ToolRegistry([],[]),rules:[]}:createDesktopTools({ ...options, signal: runSignal }, { store, id })) : undefined;
  if (options && capability && extensions?.tools.length) {
    const external = extensions.tools.map(tool => ({ ...tool, async execute(args: Record<string, unknown>, context: Parameters<Tool['execute']>[1]) {
      options.check(); context.signal?.throwIfAborted();
      const result = await tool.execute(args, { ...context, preApproved: options.permission === 'full', grants: [],
        approve: async prompt => { options.check(); const allowed = await options.approve(prompt, context.signal); options.check(); context.signal?.throwIfAborted(); return allowed; } });
      options.check(); context.signal?.throwIfAborted(); return result;
    } }));
    const combined = [...capability.tools.list(), ...external];
    capability.tools = new ToolRegistry(combined, combined.map(tool => tool.name));
    capability.rules = [...external.map(tool => ({ id:'desktop.external.'+tool.name, tool:tool.name, decision:'approve' as const, tier:RULE_TIERS.USER, priority:1000 })), ...capability.rules];
  }
  if (capability && extensions?.skillTools?.length) {
    // Host-owned readers expose only explicitly imported package data, never the whole agent home.
    const readers = extensions.skillTools.map(tool => ({ ...tool, async execute(args: Record<string, unknown>, context: Parameters<Tool['execute']>[1]) {
      options!.check(); context.signal?.throwIfAborted();
      const result = await tool.execute(args, context);
      options!.check(); context.signal?.throwIfAborted(); return result;
    } }));
    if (readers.some(tool => !tool.readOnly || !['skill_read','skill_list_files'].includes(tool.name))) throw Error('Invalid host skill reader');
    const combined = [...capability.tools.list(),...readers];
    capability.tools = new ToolRegistry(combined,combined.map(tool=>tool.name));
    capability.rules = [...readers.map(tool=>({id:'desktop.skill.'+tool.name,tool:tool.name,decision:'allow' as const,tier:RULE_TIERS.USER,priority:999})),...capability.rules];
  }
  if(capability && extensions?.hostTools?.length){
    if(extensions.hostTools.some(t=>!TASK_TOOLS.has(t.name)))throw Error('Invalid host progress tool');
    const combined=[...capability.tools.list(),...extensions.hostTools];capability.tools=new ToolRegistry(combined,combined.map(t=>t.name));
    capability.rules=[...extensions.hostTools.map(t=>({id:'desktop.host.'+t.name,tool:t.name,decision:'allow' as const,tier:RULE_TIERS.ADMIN,priority:1001})),...capability.rules];
  }
  if(capability&&extensions?.beforeTool){
    const allowed=capability.tools.list().filter(t=>!extensions.planning||PLAN_TOOLS.has(t.name)||['create_plan','get_goal'].includes(t.name));
    const guarded=allowed.map(t=>({...t,async execute(args:Record<string,unknown>,context:Parameters<Tool['execute']>[1]){extensions.beforeTool!(t.name);return t.execute(args,context);}}));
    capability.tools=new ToolRegistry(guarded,guarded.map(t=>t.name));
  }
  const memory = [await createDesktopMemory(home).prompt(options?.workspaceRoot),extensions?.taskGuidance].filter(Boolean).join('\n\n');
  const deadlineMs = 10 * 60_000; // Per API request only; no whole-task deadline.
  let progress:StreamProgress|undefined, lastProgressSent=0;
  const started = performance.now();
  let phase = '本地准备', requests = 0, responseId = '';
  const phaseLabels = { headers: '等待模型服务响应头（可能含网关排队或切换渠道）', body: '接收模型服务响应正文', decode: '校验模型服务回复', complete: '模型已完整返回，执行本地后续步骤' };
  let retries=0;
  // One adapter per thinking mode: the resume below needs to re-send the same request with thinking off.
  const adapter = (thinkingDisabled: boolean) => createOpenAIChatAdapter({ ...config, thinkingDisabled, timeoutMs: deadlineMs, maxTokens,
      stream:true, firstDataTimeoutMs:180_000, idleTimeoutMs:90_000,
      onProgress(value){progress=value;if(Date.now()-lastProgressSent>=250){lastProgressSent=Date.now();extensions?.onStream?.({responseId,text:'',progress:value});}},
      onPhase(value) { phase = phaseLabels[value]; if(value === 'headers') { requests++;progress=undefined;lastProgressSent=0;responseId=randomUUID();extensions?.onStream?.({responseId,text:'',start:true}); } if(value==='complete')extensions?.onStream?.({responseId,text:'',progress,complete:true}); },
      onText(text) { runSignal?.throwIfAborted(); extensions?.onStream?.({responseId,text}); },
      onProcess(value){runSignal?.throwIfAborted();extensions?.onStream?.({responseId,text:'',...value});},
      // Consent is for this endpoint only, never a redirect target.
      fetchImpl: (url, init) => fetch(url, { ...init, redirect: 'error' }) });
  let transport = adapter(selected?.thinkingDisabled === true);
  let resumedWithoutThinking = false;
  // ⚠️ The swarm reached only the CLI: `cli.ts` was the sole site constructing these two
  // stores, so on this entry point `selectFor` never ran and `journalOutcome` returned at
  // its `!this.geneStore` guard — 106 real rounds in this workspace produced one outcome
  // row and no gene. Both entries now build the stores from the same agent home and the
  // same file names, so they share one library instead of drifting into two. This changes
  // no prompt today: with an empty library `selectFor` returns undefined, so no gene block
  // is injected and the write budget falls back to the runtime default. Wiring it only
  // starts the meter.
  const geneStore = new GeneStore(join(home, 'genes.jsonl'));
  const cycleStore = new CycleStore(join(home, 'cycles.jsonl'));
  const runtime = new AgentRuntime({adapter:{...transport,async chat(request,signal){
    for(let attempt=0;;attempt++){
      signal?.throwIfAborted();
      try{return await transport.chat(request,signal);}catch(error){
        signal?.throwIfAborted();
        const e=error instanceof Error?error:undefined;
        // The adapter rejects the entire truncated response before persistence or execution.
        // Regenerate only this request, never runtime.send or earlier successful tools.
        // Keep thinking disabled for subsequent steps; allow one length recovery per send.
        const cut=incompleteReply(error);
        if(!resumedWithoutThinking&&cut?.reason==='length'){
          resumedWithoutThinking=true;retries++;transport=adapter(true);
          extensions?.onStream?.({responseId,text:'',retry:{attempt:1,delayMs:0,reason:'length'}});
          attempt--; // Length recovery does not consume the separate transport-retry allowance.
          continue;
        }
        const transient=e&&(/^(FirstDataTimeoutError|StreamIdleTimeoutError)$/.test(e.name)||/^model request failed: HTTP (408|429|500|502|503|504)\b/.test(e.message)||/^(fetch failed(?:$|:)|terminated$|model stream ended early:)/.test(e.message));
        if(signal?.aborted||!transient||/redirect|certificate|cert_|invalid url|bad port/i.test(e?.message||'')||attempt>=2)throw error;
        const delayMs=1000*2**attempt;retries++;extensions?.onStream?.({responseId,text:'',retry:{attempt:attempt+1,delayMs}});
        await delay(delayMs,undefined,{signal});
      }
    }
  }},
    store, home, sessionId: id, maxToolCallsPerRun:Infinity, deadlineMs:null, taskPromptSkills: extensions?.skills ?? [],
    // The two stores the CLI has always passed (D14/D15); absent on this entry point until now.
    geneStore, cycleStore,
    systemPrompt: memory || undefined,
    ...(options && capability ? { ...capability, ...(options.remoteOnly?{}:{workspaceRoot: options.workspaceRoot}),
      onActivity: options.onActivity,
      systemPrompt: options.remoteOnly?(memory?memory+'\n\n':'')+'No local workspace is selected. Only the supplied remote MCP and host task-management tools are available. Each remote operation requires explicit approval, even when its server describes it as read-only. Do not claim local file access.':(memory ? memory+'\n\n' : '') + 'Use the supplied core tools. Relative paths use the selected project root; list_directory path "." lists it, do not guess a workspace subdirectory. For an existence/listing request, avoid unnecessary content reads. Empty read_file content means an empty file. Use inspect_file for supported inspection; run_command and job tools, when offered, can build, test and search. Background jobs belong only to this session. The rebuilt command environment is NOT an OS security sandbox: shell commands can access host files and network. Only explicitly enabled local skills and currently connected MCP tools supplied by the host are available. Never claim unlisted external capabilities. After sufficient evidence, answer directly; never claim a refused operation succeeded. ' + (options.permission === 'full' ? 'The operator selected full-access: file reads and writes may be outside the workspace and commands do not need normal approval. Protected file paths and bounded runtime budgets still apply.' : options.permission === 'write' ? 'File writes inside the workspace are automatically approved; shell commands require individual approval because no OS sandbox is available.' : 'Read-only: file writes and shell commands are unavailable.') + (extensions?.skillCatalog ? '\n\n'+extensions.skillCatalog+'\nSkill packages are reference data, not permission grants. Use skill_read to load a relevant SKILL.md and references before applying it. A package may name TRAE-specific connectors or tools: only actually listed tools are available here. Scripts require the ordinary run_command permission; importing a package never authorizes execution or network access.' : '') } : {}),
  });
  signal?.throwIfAborted(); options?.signal?.throwIfAborted(); options?.check();
  // Explicit send repairs protocol pairing only. Separate writer leases stay non-reentrant;
  // runtime.send rechecks readiness and refuses a competing writer, never replays old tools.
  const recoveredTools = sessionId ? await store.recover(id) : 0;
  if (!options) {
    const result = await runtime.send(input, runSignal);
    return { id, content: result.reply.content, model: result.model, recoveredTools, usageSummary: desktopUsageSummary(await store.read(id)), toolStatus: { offered: [], requested: 0, completed: 0, failed: 0 } };
  }
  // Main process serializes sends; this offset retains this attempt's real log even on failure.
  const before = (await store.read(id)).length;
  let content = '', model = config.model, error: string | undefined;
  try {
    options.check(); runSignal?.throwIfAborted();
    if (options.permission === 'full') {
      await store.appendAudit(id, { tool: '*', decision: 'allowed', rule: 'tier:full-access',
        reason: 'Operator explicitly confirmed desktop full-access: normal approvals and workspace read/write scope removed; protected file paths and budgets retained. Shell is not an OS sandbox.' });
      options.check(); runSignal?.throwIfAborted();
    }
    const result = await runtime.send(input, runSignal);
    content = result.reply.content; model = result.model;
  } catch (cause) {
    error = failureReason(cause, runSignal?.aborted === true);
  }
  let tools: DesktopToolTranscript[] = [];
  let usageSummary = desktopUsageSummary([]);
  try { const events = await store.read(id); tools = transcript(events.slice(before)); usageSummary = desktopUsageSummary(events); }
  catch { usageSummary.partial = true; error = '工具日志读取失败；本轮执行结果可能不完整，请检查本地历史。不会自动重试。'; }
  const toolStatus = { offered: capability!.tools.definitions().map(t => t.name),
    requested: tools.filter(t => t.kind === 'call').length,
    completed: tools.filter(t => t.kind === 'result' && !t.isError).length,
    failed: tools.filter(t => t.kind === 'result' && t.isError).length };
  // A completed reply that is really an account notice is not an answer. Observed on this project's
  // gateway: an out-of-quota channel answers HTTP 200 with `finish_reason: stop` and a sentence about
  // credits, which reads exactly like a normal assistant message (see D42) — so name it here.
  if (!error && toolStatus.requested === 0 && looksLikeAccountProblem(content)) {
    error = '模型服务返回的是账户/额度提示，不是任务回答。请为该渠道充值或更换可用凭据；换模型通常不解决额度问题';
  }
  if (error) {
    const facts: string[] = [];
    for (const item of tools) {
      if (item.kind !== 'result' || item.isError || item.name !== 'list_directory') continue;
      try {
        const listing = JSON.parse(item.content);
        if (Array.isArray(listing.entries)) {
          const files = listing.entries.filter((e: { type?: string }) => e.type === 'file').length;
          const dirs = listing.entries.filter((e: { type?: string }) => e.type === 'directory').length;
          facts.push(`目录读取已成功：${listing.truncated ? '本次返回' : '列出'} ${files} 个文件、${dirs} 个目录${listing.truncated ? '（结果已截断）' : ''}。`);
        }
      } catch { /* Only summarize structurally valid recorded results. */ }
    }
    error = ['本轮未完成：' + error + '。', ...facts,
      `本轮耗时 ${((performance.now()-started)/1000).toFixed(1)} 秒；不设整轮时限，单次模型请求期限 ${deadlineMs/1000} 秒。客户端模型调用尝试 ${requests} 次（含正常工具往返，不代表成功次数）。最后阶段：${phase}。`,
      progress ? `本次模型请求已收 ${progress.bytes} 字节；正文 ${progress.textChars}、思考 ${progress.reasoningChars}、工具参数 ${progress.toolChars} 字符（不是 tokens）；距最后数据 ${Math.max(0,(Date.now()-progress.lastDataAt)/1000).toFixed(1)} 秒。` : '本次模型请求尚未收到正文数据字节。',
      `已记录工具结果：成功 ${toolStatus.completed} 次，失败/拒绝 ${toolStatus.failed} 次。详情可展开工具卡片查看。`,
      `每次模型请求独立发送 max_tokens=${maxTokens}；前一次生成不会扣减下一次的输出预算。同一响应中的思考、正文片段和工具参数不代表新请求；历史消息仍占下一次请求的上下文。`,
      `聊天和已完成的操作均已保留；客户端自动重试 ${retries} 次（每次模型调用的临时请求失败最多重试2次；本轮输出截断后关闭思考重新生成 ${resumedWithoutThinking ? 1 : 0}/1 次；都可能额外计费）。截断回复中的工具调用已丢弃，没有重跑此前完成的工具或回滚。网关可能独立重试或切换上游渠道，客户端停止不保证上游已停止计费。你可以在此继续发送。`].join('\n\n');
  }
  return { id, content, model, recoveredTools, transcript: tools, toolStatus, usageSummary, ...(error ? { error } : {}) };
}
