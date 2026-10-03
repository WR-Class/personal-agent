import { resolve } from 'node:path';
import { SessionStore } from './session-store.ts';
import { listSessions } from './interactive.ts';

/** Same home and ID format as CLI; never reads provider config or message bodies. */
export async function desktopSessions(home: string) {
  const store = new SessionStore({ root: resolve(home) });
  const ids = await listSessions(store);
  const limit = 100;
  // Reuse the store's link/hard-link checks before advertising a file as a session.
  for (const id of ids.slice(0, limit)) store.pathFor(id);
  return { ids: ids.slice(0, limit), total: ids.length, truncated: ids.length > limit };
}
