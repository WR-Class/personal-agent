/**
 * The fixture directory's retention bound (D165).
 *
 * A bound is only worth having if it cannot be got wrong quietly, so this drives the
 * prune against a throwaway root and asserts all three directions: an old run goes, a
 * recent run stays, and an old **protected** run stays — the third being the one whose
 * loss would be permanent, because the model in it does not repeat itself.
 */

import assert from "node:assert/strict";
import { after, describe, it } from "node:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { ageDirectory, pruneOldFixtures, testRunsRoot } from "./fixtures.ts";

const roots: string[] = [];

async function scratch(label: string): Promise<string> {
  const root = join(testRunsRoot, `${label}-${Math.random().toString(36).slice(2, 8)}`);
  await mkdir(root, { recursive: true });
  roots.push(root);
  return root;
}

after(async () => {
  for (const root of roots) await rm(root, { recursive: true, force: true });
});

/** Directory names only: the stamp file is bookkeeping, not a run. */
const names = async (root: string) => (await readdir(root)).filter((name) => !name.startsWith(".")).sort();

describe("a scratch directory with a retention bound", () => {
  it("⚠️ keeps the recent runs, the protected runs, and nothing else", async () => {
    const root = await scratch("retention");
    await mkdir(join(root, "old-run"));
    await mkdir(join(root, "recent-run"));
    await mkdir(join(root, "live-d159-probe"));
    await ageDirectory(join(root, "old-run"), 10);
    // Old **and** protected: this is the one a naive age-only rule would destroy.
    await ageDirectory(join(root, "live-d159-probe"), 10);

    const removed = await pruneOldFixtures(root, { retainHours: 2, intervalMs: 0, quiet: true });

    assert.equal(removed, 1, "exactly the one reproducible old run");
    assert.deepEqual(await names(root), ["live-d159-probe", "recent-run"]);
  });

  it("does not run again until the interval has passed", async () => {
    // Node starts each test file in its **own** process, so "once per process" would mean
    // one full prune per file. The stamp is what turns that into one per interval.
    const root = await scratch("retention-stamp");
    await mkdir(join(root, "old-run"));
    await ageDirectory(join(root, "old-run"), 10);

    assert.equal(await pruneOldFixtures(root, { retainHours: 2, intervalMs: 0, quiet: true }), 1);

    await mkdir(join(root, "second-old-run"));
    await ageDirectory(join(root, "second-old-run"), 10);
    assert.equal(await pruneOldFixtures(root, { retainHours: 2, quiet: true }), 0, "the stamp stopped it");
    assert.deepEqual(await names(root), ["second-old-run"]);
  });

  it("leaves a directory with nothing old in it alone", async () => {
    const root = await scratch("retention-clean");
    await mkdir(join(root, "fresh"));
    assert.equal(await pruneOldFixtures(root, { retainHours: 2, intervalMs: 0, quiet: true }), 0);
    assert.deepEqual(await names(root), ["fresh"]);
  });
});
