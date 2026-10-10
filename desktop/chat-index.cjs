'use strict';
/* Host-owned index of chat sessions and their workspace roots. Renderer never supplies paths or IDs. */
const fs = require('node:fs');
const path = require('node:path');

const MAX_SESSIONS = 500;
const MAX_WORKSPACES = 50;
const ID = /^desktop-chat-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const PERMISSIONS = new Set(['read', 'write', 'full']);

function indexPath(home) { return path.join(home, 'desktop-chat-index.json'); }

/** Drops anything that fails validation instead of trusting the file. */
function sanitize(raw) {
  const empty = { version: 1, workspaces: [], sessions: [] };
  if (!raw || typeof raw !== 'object' || raw.version !== 1) return empty;
  const workspaces = Array.isArray(raw.workspaces)
    ? raw.workspaces.filter(w => typeof w === 'string' && w && path.isAbsolute(w) && !w.includes('\0')).slice(0, MAX_WORKSPACES)
    : [];
  const seen = new Set();
  const sessions = (Array.isArray(raw.sessions) ? raw.sessions : []).filter(s => {
    if (!s || typeof s !== 'object' || !ID.test(s.id ?? '') || seen.has(s.id)) return false;
    seen.add(s.id);
    return typeof s.title === 'string' && typeof s.updatedAt === 'string' && typeof s.identity === 'string';
  }).map(s => ({
    id: s.id,
    title: s.title.slice(0, 80),
    identity: s.identity.slice(0, 2048),
    updatedAt: s.updatedAt.slice(0, 40),
    workspaceRoot: typeof s.workspaceRoot === 'string' && path.isAbsolute(s.workspaceRoot) ? s.workspaceRoot : null,
    failed: s.failed === true,
    // Session-scoped tool tier; absent means the default applies, so legacy indexes stay valid.
    ...(PERMISSIONS.has(s.permission) ? { permission: s.permission } : {}),
    ...(s.pinned === true ? { pinned: true } : {}),
  })).slice(0, MAX_SESSIONS);
  return { version: 1, workspaces, sessions };
}

function readIndex(home) {
  try {
    checkDirectory(home);
    const file = indexPath(home);
    checkFile(file);
    const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    try {
      const stat = fs.fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > 1024 * 1024) throw Error('unsafe chat index');
      const raw = JSON.parse(fs.readFileSync(fd, 'utf8'));
      if (JSON.stringify(sanitize(raw)) !== JSON.stringify(raw)) throw Error('invalid chat index');
      return raw;
    } finally { fs.closeSync(fd); }
  } catch (e) { if (e.code === 'ENOENT') return sanitize(null); throw e; }
}

function checkDirectory(home) {
  let dir = path.resolve(home);
  for (;;) {
    try { const s = fs.lstatSync(dir); if (s.isSymbolicLink() || !s.isDirectory()) throw Error('unsafe index directory'); }
    catch (e) { if (e.code !== 'ENOENT') throw e; }
    const parent = path.dirname(dir); if (parent === dir) break; dir = parent;
  }
}
function checkFile(file) {
  try { const s = fs.lstatSync(file); if (s.isSymbolicLink() || !s.isFile() || s.nlink !== 1 || s.size > 1024 * 1024) throw Error('unsafe chat index'); }
  catch (e) { if (e.code !== 'ENOENT') throw e; }
}
function writeIndex(home, index) {
  checkDirectory(home); fs.mkdirSync(home, { recursive: true });
  const file = indexPath(home), temp = file + '.' + require('node:crypto').randomUUID() + '.tmp';
  const data = JSON.stringify(sanitize(index));
  if (data.length > 1024 * 1024) throw Error('chat index too large');
  checkFile(file);
  fs.writeFileSync(temp, data, { mode: 0o600, flag: 'wx' });
  checkFile(file); fs.renameSync(temp, file);
}

/** Serialize windows; reuse the session lease to reject competing desktop processes. */
let chain = Promise.resolve();
function withIndexLease(home, action) {
  const next = chain.then(async () => {
    checkDirectory(home);
    const { withSessionLease } = await import('../src/session-lease.ts');
    return withSessionLease(indexPath(home), async () => {
      const index = readIndex(home);
      return action(index, () => writeIndex(home, index));
    });
  });
  chain = next.catch(() => {});
  return next;
}

function update(home, mutate) {
  return withIndexLease(home, (index, commit) => { const result = mutate(index); commit(); return result; });
}

function managedEntry(index, id) {
  if (typeof id !== 'string' || !ID.test(id)) throw Error('invalid desktop session id');
  const entry = index.sessions.find(s => s.id === id);
  if (!entry) throw Error('session is not indexed');
  return entry;
}
function cleanTitle(title) {
  if (typeof title !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(title) || !title.trim() || title.trim().length > 80) throw Error('title must be 1–80 characters without controls');
  return title.trim();
}
async function rename(home, id, title) {
  const cleaned = cleanTitle(title);
  return update(home, index => { const entry = managedEntry(index, id); entry.title = cleaned; return entry; });
}
function pin(home, id, pinned) {
  if (typeof pinned !== 'boolean') return Promise.reject(Error('pinned must be boolean'));
  return update(home, index => { const entry = managedEntry(index, id); if (pinned) entry.pinned = true; else delete entry.pinned; return entry; });
}
function deleteMetadata(home, id) {
  return update(home, index => { const entry = managedEntry(index, id); index.sessions = index.sessions.filter(s => s.id !== id); return entry; });
}

function remember(home, entry, check = () => {}) {
  return update(home, index => {
    check(index.sessions.find(s => s.id === entry.id));
    if (entry.workspaceRoot && !index.workspaces.includes(entry.workspaceRoot)) {
      index.workspaces.unshift(entry.workspaceRoot);
      index.workspaces = index.workspaces.slice(0, MAX_WORKSPACES);
    }
    const existing = index.sessions.find(s => s.id === entry.id);
    const merged = { ...(existing ?? {}), ...entry, updatedAt: new Date().toISOString() };
    index.sessions = [merged, ...index.sessions.filter(s => s.id !== entry.id)].slice(0, MAX_SESSIONS);
    return merged;
  });
}

function markFailed(home, id, failed) {
  return update(home, index => {
    const entry = index.sessions.find(s => s.id === id);
    if (entry) entry.failed = failed;
    return entry ?? null;
  });
}

/** Records the tier the user picked for one session; an unknown or unindexed session is a no-op, not an error. */
function setPermission(home, id, permission) {
  if (!ID.test(id ?? '') || !PERMISSIONS.has(permission)) return Promise.reject(Error('invalid session permission'));
  return update(home, index => {
    const entry = index.sessions.find(s => s.id === id);
    if (!entry) return null;
    entry.permission = permission;
    return entry;
  });
}

function rememberWorkspace(home, root) {
  return update(home, index => {
    if (!path.isAbsolute(root)) throw new Error('workspace root must be absolute');
    index.workspaces = [root, ...index.workspaces.filter(w => w !== root)].slice(0, MAX_WORKSPACES);
    return index.workspaces;
  });
}

function list(home) {
  const index = readIndex(home);
  return {
    workspaces: index.workspaces,
    sessions: [...index.sessions].sort((a, b) => Number(b.pinned === true) - Number(a.pinned === true)).map(s => ({ id: s.id, title: s.title, updatedAt: s.updatedAt, workspaceRoot: s.workspaceRoot, failed: s.failed, ...(s.pinned === true ? { pinned: true } : {}) })),
  };
}

function find(home, id) {
  return readIndex(home).sessions.find(s => s.id === id) ?? null;
}

module.exports = { readIndex, writeIndex, sanitize, remember, markFailed, rememberWorkspace, setPermission, list, find, indexPath, MAX_SESSIONS, rename, pin, deleteMetadata, withIndexLease, managedEntry, cleanTitle };
