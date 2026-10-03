import { resolve } from 'node:path';
import { SessionStore } from './session-store.ts';
import { listSessions } from './interactive.ts';

export async function desktopHistory(home: string, id: unknown) {
  if (typeof id !== 'string' || id.length > 200 || !/^[A-Za-z0-9._-]+$/.test(id) || ['genes', 'cycles'].includes(id.toLowerCase())) throw new Error('invalid session id');
  const store = new SessionStore({ root: resolve(home), maxReadBytes: 1024 * 1024 });
  const events = await store.read(id);
  if (!events.length) throw new Error('session missing');
  const messages = events.filter(e => e.kind === 'message');
  return { id, total: messages.length, truncated: messages.length > 200,
    messages: messages.slice(-200).map(e => ({ role: e.message.role, content: e.message.content,
      toolCalls: e.message.toolCalls?.map(call => ({ name: call.name, arguments: call.arguments })) })) };
}

/** Same home and ID format as CLI; never reads provider config or message bodies. */
export async function desktopSessions(home: string) {
  const store = new SessionStore({ root: resolve(home) });
  const ids = await listSessions(store);
  const limit = 100;
  // Reuse the store's link/hard-link checks before advertising a file as a session.
  for (const id of ids.slice(0, limit)) store.pathFor(id);
  return { ids: ids.slice(0, limit), total: ids.length, truncated: ids.length > limit };
}
