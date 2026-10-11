import { mkdir, mkdtemp, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { assertSafeStateDirectory } from "../src/security-config.ts";

export const testRunsRoot = fileURLToPath(new URL("../.test-artifacts/", import.meta.url));

/**
 * How long a run directory is kept (D165).
 *
 * ⚠️ These used to be kept forever — "retained for inspection, never cleaned up" — and
 * the reason was sound: after a **flaky** failure the fixture is the only place the
 * evidence exists, because a failure that reproduces would not need the fixture at all.
 *
 * What was missing is a bound. Measured before this change: 52,976 run directories,
 * 259,425 files, 3.17 GB, 18 days. The retention was defeating itself — the whole point
 * is being able to go and look, and at that size the tools for looking time out. And
 * almost nothing was lost by deleting: half the directories are under 1 KB, and the disk
 * cost is concentrated in a few hundred that repeated the same test forty times.
 *
 * Two days is chosen for what the retention is actually for: the failure you go and
 * inspect is the one that just happened. Everything else comes back by re-running the
 * test, because the model in it is a script.
 */
export const RETAIN_HOURS = 48;

/**
 * Prefixes whose contents are **not** reproducible, and are therefore never pruned.
 *
 * A fixture written by the scripted model is recreated by re-running its test. A fixture
 * written by a **real** model is not: the model does not repeat itself, and a probe's
 * transcript is the evidence for a recorded finding. Those are the only things here that
 * would be lost for good.
 *
 * This is a prefix rather than a list of names on purpose — the producer writes it, so a
 * future instrument is protected by construction instead of by someone remembering to
 * add it here. `scripts/d159-live-probe.ts` writes it; the `d159` in that file's name is
 * the round that added it, which is why the file and the prefix do not match.
 */
export const PROTECTED_PREFIXES: readonly string[] = ["live-"];

/** How often the prune may actually run, however many test files start at once. */
export const PRUNE_INTERVAL_MS = 3_600_000;

export interface PruneOptions {
  retainHours?: number;
  intervalMs?: number;
  /** Silence the one-line report; the tests use this so the output stays readable. */
  quiet?: boolean;
}

/**
 * Delete run directories older than the retention window.
 *
 * Exported and parameterised so it can be pointed at a throwaway root and tested; the
 * fixture factory below is its only production caller.
 *
 * The interval stamp exists because node's test runner starts each file in its **own**
 * process, so "once per process" would mean fifty prunes per run. One stamp file turns
 * that into one prune per hour, and the extra directories a run can add inside that hour
 * are a few hundred — bounded, which is the whole point.
 */
export async function pruneOldFixtures(root: string, options: PruneOptions = {}): Promise<number> {
  const retainHours = options.retainHours ?? RETAIN_HOURS;
  const intervalMs = options.intervalMs ?? PRUNE_INTERVAL_MS;
  const stamp = join(root, ".prune-stamp");
  if (intervalMs > 0) {
    try {
      const info = await stat(stamp);
      if (Date.now() - info.mtimeMs < intervalMs) return 0;
    } catch {
      // No stamp yet: this is the first run in this directory.
    }
  }

  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return 0;
  }

  const cutoff = Date.now() - retainHours * 3_600_000;
  let removed = 0;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (PROTECTED_PREFIXES.some((prefix) => entry.name.startsWith(prefix))) continue;
    const path = join(root, entry.name);
    try {
      const info = await stat(path);
      if (info.mtimeMs >= cutoff) continue;
      await rm(path, { recursive: true, force: true });
      removed += 1;
    } catch {
      // A directory that vanished under us is the outcome we wanted. A permission
      // problem is not worth failing a test run over — the next run tries again.
    }
  }

  // Written even when nothing was removed, so a directory that is already clean does not
  // pay for a full listing on every test file.
  await writeFile(stamp, `${new Date().toISOString()} removed=${removed}\n`, "utf8").catch(() => {});
  if (removed > 0 && options.quiet !== true) {
    process.stderr.write(`[fixtures] pruned ${removed} run director${removed === 1 ? "y" : "ies"} older than ${retainHours}h\n`);
  }
  return removed;
}

export interface TestFixture {
  root: string;
  storeRoot: string;
  home: string;
  workspaceRoot: string;
}

/**
 * Unique, owned test artifacts, retained for inspection but **bounded** (D165).
 *
 * The prune runs before the directory is created, so a run can never add to a directory
 * that has already exceeded the window by more than the window itself.
 */
export async function createTestFixture(label: string): Promise<TestFixture> {
  if (!/^[a-z0-9-]+$/i.test(label)) throw new Error("invalid test fixture label");
  const safeBase = assertSafeStateDirectory(testRunsRoot);
  await mkdir(safeBase, { recursive: true });
  await pruneOldFixtures(safeBase);
  const root = await mkdtemp(join(safeBase, `${label}-`));
  await writeFile(join(root, ".fixture-owner.json"), `${JSON.stringify({
    owner: "personal-agent-tests",
    label,
    createdAt: new Date().toISOString(),
    retained: true,
  }, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  const fixture = {
    root,
    storeRoot: join(root, "store"),
    home: join(root, "home"),
    workspaceRoot: join(root, "workspace"),
  };
  for (const directory of [fixture.storeRoot, fixture.home, fixture.workspaceRoot]) {
    await mkdir(directory);
  }
  return fixture;
}

/** Only used by the retention test, to make an old directory look old. */
export async function ageDirectory(path: string, hoursAgo: number): Promise<void> {
  const when = new Date(Date.now() - hoursAgo * 3_600_000);
  await utimes(path, when, when);
}
