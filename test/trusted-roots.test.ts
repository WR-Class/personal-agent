/**
 * Additional readable roots (D35).
 *
 * The property under test is an asymmetry: granting a readable root makes reads
 * inside it work and changes nothing about writes. Most of these tests exist to
 * pin one half of that pair, because a widening that also widened writes would
 * still pass a naive "can I read it now" test.
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { checkReadable, grantReadableRoot, readTrustedRoots, revokeReadableRoot } from "../src/trusted-roots.ts";
import { createCreateFileTool, createEditFileTool, createPatchFileTool, createReadFileTool } from "../src/tools.ts";
import type { ToolContext } from "../src/tools.ts";

let home: string;
let workspace: string;
let outside: string;

before(async () => {
  const base = await mkdtemp(path.join(tmpdir(), "trusted-roots-"));
  home = path.join(base, "home");
  workspace = path.join(base, "workspace");
  outside = path.join(base, "outside");
  await mkdir(home, { recursive: true });
  await mkdir(workspace, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(outside, "source.c"), "int main(void) { return 0; }\n", "utf8");
});

after(async () => {
  const { rm } = await import("node:fs/promises");
  await rm(path.dirname(home), { recursive: true, force: true });
});

describe("readable roots", () => {
  it("refuses a path outside the workspace when nothing was granted", async () => {
    const granted = await readTrustedRoots(home);
    assert.deepEqual(granted, []);
    const reason = checkReadable(path.join(outside, "source.c"), workspace, granted);
    assert.equal(reason, "path escapes the workspace");
  });

  it("allows the same path once its root is granted", async () => {
    await grantReadableRoot(home, outside);
    const granted = await readTrustedRoots(home);
    assert.equal(checkReadable(path.join(outside, "source.c"), workspace, granted), undefined);
  });

  it("still refuses the workspace itself from being squeezed out", async () => {
    const granted = await readTrustedRoots(home);
    assert.equal(checkReadable(path.join(workspace, "a.txt"), workspace, granted), undefined);
  });

  it("keeps refusing a sibling root that was never granted", async () => {
    const sibling = path.join(path.dirname(workspace), "untouched");
    const granted = await readTrustedRoots(home);
    assert.equal(checkReadable(path.join(sibling, "secret.txt"), workspace, granted), "path escapes the workspace");
  });

  it("applies the sensitive-name list inside an added root", async () => {
    const granted = await readTrustedRoots(home);
    // An added root means the tree is readable, not every file in it. If this
    // passed, widening reads would make protection weaker than in the workspace.
    assert.equal(checkReadable(path.join(outside, ".env"), workspace, granted), "sensitive path is denied");
    assert.equal(checkReadable(path.join(outside, ".git", "config"), workspace, granted), "sensitive path is denied");
    assert.equal(checkReadable(path.join(outside, "server.pem"), workspace, granted), "sensitive path is denied");
  });

  it("stores trust outside the workspace", async () => {
    const text = await readFile(path.join(home, "trust.json"), "utf8");
    assert.match(text, /"readableRoots"/);
    // A trust file inside the repo would be attacker-controlled: cloning a
    // hostile repo would ship its own grant.
    await assert.rejects(() => readFile(path.join(workspace, "trust.json"), "utf8"));
  });

  it("grants idempotently and revokes", async () => {
    await grantReadableRoot(home, outside);
    assert.deepEqual((await readTrustedRoots(home)).length, 1);
    assert.equal(await revokeReadableRoot(home, outside), true);
    assert.deepEqual(await readTrustedRoots(home), []);
    assert.equal(await revokeReadableRoot(home, outside), false);
  });

  it("refuses the filesystem root", async () => {
    const root = path.parse(home).root;
    await assert.rejects(() => grantReadableRoot(home, root), /refuses filesystem root/);
  });

  it("refuses a corrupt trust file instead of reading it as empty", async () => {
    const broken = await mkdtemp(path.join(tmpdir(), "trusted-broken-"));
    await writeFile(path.join(broken, "trust.json"), "{not json", "utf8");
    // Defaulting to empty would be indistinguishable from "still confined",
    // which is the wrong answer when the file was meant to widen reads.
    await assert.rejects(() => readTrustedRoots(broken), /not valid JSON/);
  });
});

/**
 * The half that a naive "can I read it now?" test would miss.
 *
 * Every assertion here fails if someone later routes the write tools through the
 * widened read check, which is the single mistake this design exists to prevent.
 * The refusal must also cite path confinement rather than some unrelated
 * argument error, or the test would pass for the wrong reason.
 */
describe("a readable root never widens writes", () => {
  let base: string;
  let context: ToolContext & { approve: () => Promise<boolean> };
  let outsideFile: string;

  before(async () => {
    base = await mkdtemp(path.join(tmpdir(), "trusted-write-"));
    const ws = path.join(base, "ws");
    const out = path.join(base, "outside");
    await mkdir(ws, { recursive: true });
    await mkdir(out, { recursive: true });
    outsideFile = path.join(out, "source.c");
    await writeFile(outsideFile, "int main(void) { return 0; }\n", "utf8");
    context = { workspaceRoot: ws, approve: async () => true, readableRoots: [out], protectedStateRoots: [] };
  });

  after(async () => {
    const { rm } = await import("node:fs/promises");
    await rm(base, { recursive: true, force: true });
  });

  it("lets read_file read the granted root", async () => {
    const tool = createReadFileTool();
    const result = await tool.execute({ path: outsideFile }, context);
    // A successful tool result simply omits `isError` rather than setting false.
    assert.notEqual(result.isError, true);
    assert.match(String(result.content), /int main/);
  });

  const writeAttempts: ReadonlyArray<readonly [string, () => Promise<{ isError?: boolean; content: unknown }>]> = [
    ["edit_file", () => createEditFileTool().execute({ path: outsideFile, content: "int x;\n" }, context)],
    ["patch_file", () => createPatchFileTool().execute({ path: outsideFile, oldText: "int main", newText: "int x" }, context)],
    ["create_file", () => createCreateFileTool().execute({ path: path.join(base, "outside", "new.c"), content: "x\n" }, context)],
  ];

  for (const [name, attempt] of writeAttempts) {
    it(`still confines ${name} to the workspace`, async () => {
      const result = await attempt();
      assert.equal(result.isError, true);
      // Must cite confinement, not some unrelated argument error: refusing for
      // the wrong reason would let this test pass while writes were open.
      assert.match(String(result.content), /escapes the workspace/);
    });
  }
});
