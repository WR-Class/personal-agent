import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { lstat, open, rename, unlink } from 'node:fs/promises';
import { SessionStore, type SessionEvent } from './session-store.ts';

const index = createRequire(import.meta.url)('../desktop/chat-index.cjs');
type Entry = { id: string; title: string; pinned?: true };
type Index = { sessions: Entry[] };

/** Index first, then session lease throughout: no nested acquisition of the same index lock. */
async function managed<T>(home: string, id: unknown, action: (store: SessionStore, entry: Entry, state: Index, commit: () => void) => Promise<T>): Promise<T> {
  return index.withIndexLease(home, async (state: Index, commit: () => void) => {
    const entry = index.managedEntry(state, id) as Entry;
    const store = new SessionStore({ root: home, maxReadBytes: 1024 * 1024 });
    return store.withWriter(entry.id, async () => {
      const events = await store.read(entry.id);
      if (!events.length) throw Error('session history missing');
      await store.pendingTools(entry.id); // Strict pairing check; never repairs before a destructive action.
      return action(store, entry, state, commit);
    });
  });
}

export async function renameSession(home: string, id: unknown, title: unknown) {
  const cleaned = index.cleanTitle(title) as string;
  return managed(home, id, async (_store, entry, _state, commit) => { entry.title = cleaned; commit(); return { id: entry.id, title: cleaned }; });
}

export async function pinSession(home: string, id: unknown, pinned: unknown) {
  if (typeof pinned !== 'boolean') throw Error('pinned must be boolean');
  return managed(home, id, async (_store, entry, _state, commit) => {
    if (pinned) entry.pinned = true; else delete entry.pinned;
    commit(); return { id: entry.id, pinned };
  });
}

export async function deleteSession(home: string, id: unknown) {
  return managed(home, id, async (store, entry, state, commit) => {
    const source = store.pathFor(entry.id), archive = source + '.' + randomUUID() + '.deleted';
    // The archive is not .jsonl, so legacy discovery cannot resurrect a deleted conversation.
    const reserved = await open(archive, 'wx', 0o600); await reserved.close();
    try { store.pathFor(entry.id); await rename(source, archive); }
    catch (error) { await unlink(archive); throw error; }
    try {
      state.sessions = state.sessions.filter(s => s.id !== entry.id);
      commit();
    } catch (error) {
      // Refuse to overwrite a newly created history during rollback; keep the archive as evidence.
      try { await lstat(source); throw Error('session deletion rollback refused: history changed; archive retained'); }
      catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ENOENT') throw check; }
      await rename(archive, source);
      throw error;
    }
    try {
      const stat = await lstat(archive);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw Error('unsafe deleted archive');
      await unlink(archive);
      return { id: entry.id, deleted: true, purgePending: false };
    } catch {
      // Metadata removal committed. Report retained data honestly instead of silently claiming erasure.
      return { id: entry.id, deleted: true, purgePending: true };
    }
  });
}

export async function exportSession(home: string, id: unknown, format: unknown = 'markdown') {
  if (format !== 'markdown' && format !== 'json') throw Error('unsupported export format');
  return managed(home, id, async (store, entry) => {
    const events = await store.read(entry.id);
    const messages = events.filter((e): e is Extract<SessionEvent, {kind:'message'}> => e.kind === 'message')
      .map(e => ({ role: e.message.role, content: e.message.content,
        ...(e.message.toolCalls ? { toolCalls: e.message.toolCalls } : {}),
        ...(e.message.toolCallId ? { toolCallId: e.message.toolCallId } : {}),
        ...(e.isError === undefined ? {} : { isError: e.isError }) }));
    // Code fences are longer than any run in the content: user/tool text cannot break out into HTML.
    const fence = (text: string) => { const mark = '`'.repeat(Array.from(text.matchAll(/`+/g)).reduce((length, match) => Math.max(length, match[0].length + 1), 3)); return `${mark}text\n${text}\n${mark}`; };
    const content = format === 'json' ? JSON.stringify({ id: entry.id, title: entry.title, messages }, null, 2) + '\n'
      : [`# Conversation ${entry.id}`, fence(entry.title), ...messages.map(m => `## ${m.role}\n\n${fence(m.content)}${m.toolCalls ? '\n\nTool calls\n\n' + fence(JSON.stringify(m.toolCalls, null, 2)) : ''}${m.toolCallId ? '\n\nTool result\n\n' + fence(JSON.stringify({ toolCallId: m.toolCallId, isError: m.isError })) : ''}`)].join('\n\n') + '\n';
    if (Buffer.byteLength(content, 'utf8') > 4 * 1024 * 1024) throw Error('export exceeds 4 MiB');
    return { filename: entry.id + (format === 'json' ? '.json' : '.md'), content };
  });
}
