import { randomUUID } from 'node:crypto';
import { loadProvider } from './cli-config.ts';
import { createOpenAIChatAdapter } from './openai-adapter.ts';
import { AgentRuntime } from './runtime.ts';
import { SessionStore } from './session-store.ts';

export async function desktopProvider(home: string, env: NodeJS.ProcessEnv = process.env) {
  const config = await loadProvider(home, env);
  if (!config || config.apiKey === '__ASK_AT_START__') throw new Error('complete provider configuration required');
  return { baseUrl: config.baseUrl, model: config.model };
}

export async function desktopModelSend(home: string, input: unknown, expected: { baseUrl: string; model: string }, env: NodeJS.ProcessEnv = process.env, selected?: { baseUrl: string; model: string; apiKey: string }) {
  if (typeof input !== 'string' || !input.trim() || Buffer.byteLength(input) > 8192) throw new Error('invalid input');
  const config = selected ?? await loadProvider(home, env);
  if (!config || config.apiKey === '__ASK_AT_START__' || !expected || config.baseUrl !== expected.baseUrl || config.model !== expected.model) throw new Error('provider changed or unavailable');
  const id = `desktop-model-${randomUUID()}`;
  const runtime = new AgentRuntime({ adapter: createOpenAIChatAdapter({ ...config, timeoutMs: 60000, maxTokens: 2048,
      // Consent is for this endpoint only, never a redirect target.
      fetchImpl: (url, init) => fetch(url, { ...init, redirect: 'error' }) }),
    store: new SessionStore({ root: home, maxReadBytes: 1024 * 1024 }),
    home, sessionId: id, maxSteps: 1, deadlineMs: 60000, taskPromptSkills: [] });
  const result = await runtime.send(input);
  return { id, content: result.reply.content, model: result.model };
}
