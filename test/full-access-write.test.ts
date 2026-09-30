import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { assertReadablePath, canonicalPath } from "../src/security-config.ts";

/**
 * `full-access` means "the operator stopped being asked about *where*", not "the
 * agent may edit the operator's own text". These four assertions are the whole of
 * that sentence: the first two are the widening, the last two are what
 * deliberately survives it.
 *
 * Written after the implementation, which is backwards, and the reason is worth
 * keeping: the first version of this change lifted the protected-root loop too,
 * and two existing tests went red —
 *   "cannot write the constraints file it is told from, whatever its home is called"
 *   "cannot write its own privilege-granting state, whatever its home is called"
 * Those two cover the agent-home case end to end through the real runtime. These
 * cover the gate itself, which is where the distinction actually lives, so that a
 * future edit narrowing or widening `unrestricted` fails here with the reason
 * visible rather than there with a fixture path in the message.
 */
// Not `os.tmpdir()`, and the reason is a trap worth keeping written down: on
// Windows the temp dir is `%LOCALAPPDATA%\Temp`, which `protectedRoots()` denies
// in its own right. A boundary test placed there does not test workspace
// containment at all — it exercises the protected-root loop and passes or fails
// for reasons that have nothing to do with the tier. `fixtures.ts` puts test
// artifacts inside the repository for the same reason. Unlike the fixture these
// are removed, because nothing here is worth inspecting afterwards.
const artifactsRoot = fileURLToPath(new URL("../.test-artifacts/", import.meta.url));

describe("full-access write boundary", () => {
  const created: string[] = [];

  after(async () => {
    for (const dir of created) await rm(dir, { recursive: true, force: true });
  });

  async function scratch(): Promise<string> {
    await mkdir(artifactsRoot, { recursive: true });
    const dir = await mkdtemp(path.join(artifactsRoot, "pa-fullaccess-"));
    created.push(dir);
    return dir;
  }

  it("refuses a path outside the workspace when the tier is not full-access", async () => {
    const workspace = await scratch();
    const outside = path.join(await scratch(), "notes.txt");
    assert.throws(() => assertReadablePath(outside, workspace, [], false), /path escapes the workspace/);
  });

  it("allows that same path when the tier is full-access", async () => {
    const workspace = await scratch();
    const outside = path.join(await scratch(), "notes.txt");
    assert.equal(assertReadablePath(outside, workspace, [], true), canonicalPath(outside));
  });

  it("still refuses a protected root at full access: the agent's own state is not a place", async () => {
    const workspace = await scratch();
    const agentHome = await scratch();
    const target = path.join(agentHome, "constraints.json");
    assert.throws(() => assertReadablePath(target, workspace, [agentHome], true), /sensitive path is denied/);
  });

  it("still refuses a sensitive name at full access", async () => {
    const workspace = await scratch();
    const root = await scratch();
    // Created rather than merely named, so a failure here is the check firing and
    // not canonicalization tripping over a path that does not exist.
    await mkdir(path.join(root, ".ssh"), { recursive: true });
    const target = path.join(root, ".ssh", "authorized_keys");
    assert.throws(() => assertReadablePath(target, workspace, [], true), /sensitive path is denied/);
  });
});
