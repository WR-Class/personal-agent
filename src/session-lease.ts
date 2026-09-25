import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import { mkdir, open, lstat, readFile, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { canonicalPath } from "./security-config.ts";

const scope = new AsyncLocalStorage<{ key: string; active: boolean }>();
export class SessionBusyError extends Error {
  constructor() { super("会话被另一写入者占用，或上次异常退出留下锁。不会自动抢锁；请关闭其他实例并检查 .jsonl.lock。"); this.name="SessionBusyError"; }
}
/** Cooperative local-filesystem lock, not a hostile-process or network-filesystem lock. */
export async function withSessionLease<T>(file: string, action: () => Promise<T>, reentrant = false): Promise<T> {
  const key = process.platform === "win32" ? file.toLowerCase() : file;
  const current = scope.getStore();
  if (reentrant && current?.active && current.key === key) return action();
  await mkdir(dirname(file), { recursive: true });
  const lock = `${file}.lock`;
  // Existing symlinks, stale files and incomplete locks all refuse acquisition.
  let handle;
  try { handle = await open(lock, "wx", 0o600); }
  catch(error) { if((error as NodeJS.ErrnoException).code==="EEXIST")throw new SessionBusyError(); throw error; }
  const token = JSON.stringify({ v:1,pid:process.pid,token:randomUUID(),createdAt:new Date().toISOString() });
  const owned = { key, active:true };
  try {
    await handle.writeFile(token,"utf8"); await handle.sync();
    return await scope.run(owned, action);
  } finally {
    owned.active=false;
    const identity = await handle.stat();
    await handle.close();
    // Release only the exact owned regular leaf; never recursive cleanup or stale-lock takeover.
    const info = await lstat(lock);
    if(info.isSymbolicLink() || info.nlink!==1 || info.dev!==identity.dev || info.ino!==identity.ino ||
      canonicalPath(lock)!==lock || await readFile(lock,"utf8")!==token) throw new Error("会话锁归属已改变，保留现场，拒绝释放");
    await unlink(lock);
  }
}
