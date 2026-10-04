import { randomUUID } from 'node:crypto';
import { loadProvider } from './cli-config.ts';
import { createOpenAIChatAdapter } from './openai-adapter.ts';
import { AgentRuntime } from './runtime.ts';
import { SessionStore } from './session-store.ts';
import type { SessionEvent } from './session-store.ts';
import { createDesktopTools } from './desktop-tools.ts';
import type { DesktopToolOptions } from './desktop-tools.ts';

export type DesktopToolTranscript =
  | { kind: 'call'; callId: string; name: string; arguments: string }
  | { kind: 'result'; callId: string; name: string; content: string; isError: boolean };
export interface DesktopModelResult {
  id: string;
  content: string;
  model: string;
  transcript?: DesktopToolTranscript[];
  error?: string;
  toolStatus?: { offered: string[]; requested: number; completed: number; failed: number };
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

export async function desktopProvider(home: string, env: NodeJS.ProcessEnv = process.env) {
  const config = await loadProvider(home, env);
  if (!config || config.apiKey === '__ASK_AT_START__') throw new Error('complete provider configuration required');
  return { baseUrl: config.baseUrl, model: config.model };
}

export async function desktopModelSend(home: string, input: unknown, expected: { baseUrl: string; model: string }, env: NodeJS.ProcessEnv = process.env, selected?: { baseUrl: string; model: string; apiKey: string }, sessionId?: string, options?: DesktopToolOptions, signal?: AbortSignal): Promise<DesktopModelResult> {
  if (typeof input !== 'string' || !input.trim() || Buffer.byteLength(input) > 8192) throw new Error('invalid input');
  const config = selected ?? await loadProvider(home, env);
  if (!config || config.apiKey === '__ASK_AT_START__' || !expected || config.baseUrl !== expected.baseUrl || config.model !== expected.model) throw new Error('provider changed or unavailable');
  // sessionId is supplied only by the trusted host's per-window conversation state.
  if (sessionId !== undefined && !/^desktop-chat-[0-9a-f-]{36}$/.test(sessionId)) throw new Error('invalid desktop session');
  const id = sessionId ?? `desktop-model-${randomUUID()}`;
  const store = new SessionStore({ root: home, maxReadBytes: 1024 * 1024 });
  const capability = options ? createDesktopTools(options) : undefined;
  const deadlineMs = options ? 180000 : 60000;
  const runtime = new AgentRuntime({ adapter: createOpenAIChatAdapter({ ...config, timeoutMs: deadlineMs, maxTokens: 2048,
      // Consent is for this endpoint only, never a redirect target.
      fetchImpl: (url, init) => fetch(url, { ...init, redirect: 'error' }) }),
    store, home, sessionId: id, maxSteps: options ? 6 : 1, deadlineMs, taskPromptSkills: [],
    ...(options && capability ? { ...capability, workspaceRoot: options.workspaceRoot,
      maxToolCallsPerStep: 2, maxToolCallsPerRun: 8, maxWriteFiles: 3, maxWriteLines: 200,
      onActivity: options.onActivity,
      systemPrompt: 'Use only the supplied workspace file tools. list_directory lists names; read_file reads files. Editing requires individual operator approval. No command execution, network tools, MCP or skills are available. Never claim a refused operation succeeded.' } : {}),
  });
  if (!options) {
    const result = await runtime.send(input, signal);
    return { id, content: result.reply.content, model: result.model, toolStatus: { offered: [], requested: 0, completed: 0, failed: 0 } };
  }
  // Main process serializes sends; this offset retains this attempt's real log even on failure.
  const before = (await store.read(id)).length;
  let content = '', model = config.model, error: string | undefined;
  try {
    options.check(); options.signal?.throwIfAborted();
    const result = await runtime.send(input, options.signal ?? signal);
    content = result.reply.content; model = result.model;
  } catch {
    error = '本轮未正常完成；可能已有文件操作或部分日志，请检查工具记录。不会自动重试。';
  }
  let tools: DesktopToolTranscript[] = [];
  try { tools = transcript((await store.read(id)).slice(before)); }
  catch { error = '工具日志读取失败；本轮执行结果可能不完整，请检查本地历史。不会自动重试。'; }
  const toolStatus = { offered: capability!.tools.definitions().map(t => t.name),
    requested: tools.filter(t => t.kind === 'call').length,
    completed: tools.filter(t => t.kind === 'result' && !t.isError).length,
    failed: tools.filter(t => t.kind === 'result' && t.isError).length };
  return { id, content, model, transcript: tools, toolStatus, ...(error ? { error } : {}) };
}
