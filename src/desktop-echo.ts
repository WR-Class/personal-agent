import { randomUUID } from 'node:crypto';
import { AgentRuntime } from './runtime.ts';
import { SessionStore } from './session-store.ts';
import { createEchoAdapter } from './echo-adapter.ts';

/**
 * Explicit offline smoke turn: no provider config, no tools, fresh session only.
 *
 * ⚠️ Deliberately no `geneStore`/`cycleStore`, and this is a decision rather than an
 * omission: `createEchoAdapter` echoes the request verbatim, so `roundVeto` vetoes
 * every round here as an echo and the row would be journaled as a **failure**. Wiring
 * the stores would charge a gene for a smoke turn. The real desktop entry point is
 * `desktop-model.ts`; that file, `cli.ts` and this one are the only three construction
 * sites of `AgentRuntime` outside tests.
 */
export async function desktopEcho(home: string, input: unknown) {
  if (typeof input !== 'string' || !input.trim() || Buffer.byteLength(input) > 8192) throw new Error('Echo input must be 1–8192 bytes');
  const id = `desktop-echo-${randomUUID()}`;
  const runtime = new AgentRuntime({ adapter: createEchoAdapter(),
    store: new SessionStore({ root: home, maxReadBytes: 1024 * 1024 }),
    home, sessionId: id, maxSteps: 1, deadlineMs: 15000, taskPromptSkills: [] });
  const result = await runtime.send(input);
  return { id, content: result.reply.content, mode: 'offline-echo' };
}
