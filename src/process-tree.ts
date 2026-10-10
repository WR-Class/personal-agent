import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

export const PROCESS_CLEANUP_MS = 8_000;
// Unix jobs get their own process group. Do not unref: the owner still awaits cleanup.
export const processGroupOptions = { detached: process.platform !== 'win32' };
const systemRoot = process.env.SystemRoot || process.env.WINDIR;
const taskkill = systemRoot && path.isAbsolute(systemRoot) ? path.join(systemRoot, 'System32', 'taskkill.exe') : undefined;

/** Only accepts children created by this process; never resolves before tree termination is requested/confirmed. */
export async function terminateProcessTree(child: ChildProcess): Promise<void> {
  if (child.pid === undefined) return;
  if (process.platform !== 'win32') {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
    return;
  }
  if (!taskkill) throw new Error('cannot stop process tree: trusted SystemRoot unavailable');
  await new Promise<void>((resolve, reject) => {
    const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', shell: false });
    const timer = setTimeout(() => { killer.kill(); reject(new Error('process tree cleanup timed out')); }, PROCESS_CLEANUP_MS);
    killer.once('error', error => { clearTimeout(timer); reject(error); });
    killer.once('close', code => {
      clearTimeout(timer);
      // A parent exit alone cannot prove descendants exited. Never silently downgrade to child.kill().
      if (code === 0) resolve();
      else reject(new Error(`process tree termination failed (${code})`));
    });
  });
}

export async function boundedCleanup(done: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([done, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('process close cleanup timed out')), PROCESS_CLEANUP_MS);
    })]);
  } finally { clearTimeout(timer); }
}
