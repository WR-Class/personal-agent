import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ToolRegistry, createEditFileTool, createPatchFileTool, createDeleteFileTool } from "../src/tools.ts";
import { createTestFixture } from "./fixtures.ts";
import type { ToolContext } from "../src/tools.ts";
import type { ToolCall } from "../src/types.ts";

let fixture: Awaited<ReturnType<typeof createTestFixture>>;

before(async () => {
  fixture = await createTestFixture("drift");
});

function call(name: string, args: Record<string, unknown>, id = `call_${name}`): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

/**
 * A context whose approval channel mutates the file while the operator is
 * "deciding". That is the whole point: approval is asynchronous and can take
 * minutes, so the world can move between the decision and the write.
 */
function contextWithDrift(onApprove: () => Promise<void>): ToolContext {
  return {
    workspaceRoot: fixture.workspaceRoot,
    protectedRoots: [],
    readPaths: new Set<string>(),
    approve: async () => {
      await onApprove();
      return true;
    },
  } as unknown as ToolContext;
}

describe("drift between approval and write", () => {
  it("refuses edit_file when the file changed after the operator approved", async () => {
    const path = join(fixture.workspaceRoot, "drift-edit.txt");
    await writeFile(path, "original\n", "utf8");
    const registry = new ToolRegistry([createEditFileTool()]);
    const result = await registry.execute(
      call("edit_file", { path: "drift-edit.txt", content: "approved content\n" }),
      contextWithDrift(async () => {
        await writeFile(path, "changed by someone else\n", "utf8");
      }),
    );
    assert.equal(result.isError, true, "a write over a file that moved must be refused");
    assert.match(result.content, /changed/);
    // The other writer's content must survive untouched.
    assert.equal(await readFile(path, "utf8"), "changed by someone else\n");
  });

  it("refuses patch_file when the file changed after approval", async () => {
    const path = join(fixture.workspaceRoot, "drift-patch.txt");
    await writeFile(path, "alpha\nbeta\n", "utf8");
    const registry = new ToolRegistry([createPatchFileTool()]);
    const result = await registry.execute(
      call("patch_file", { path: "drift-patch.txt", oldText: "alpha", newText: "ALPHA" }),
      contextWithDrift(async () => {
        await writeFile(path, "alpha\nbeta\ngamma\n", "utf8");
      }),
    );
    assert.equal(result.isError, true, "splicing into stale content would revert the other writer");
    assert.equal(await readFile(path, "utf8"), "alpha\nbeta\ngamma\n");
  });

  it("still performs the write when nothing drifted", async () => {
    const path = join(fixture.workspaceRoot, "no-drift.txt");
    await writeFile(path, "before\n", "utf8");
    const registry = new ToolRegistry([createEditFileTool()]);
    const result = await registry.execute(
      call("edit_file", { path: "no-drift.txt", content: "after\n" }),
      contextWithDrift(async () => {}),
    );
    assert.notEqual(result.isError, true, result.content);
    assert.equal(await readFile(path, "utf8"), "after\n");
  });

  it("still performs a patch when nothing drifted", async () => {
    const path = join(fixture.workspaceRoot, "no-drift-patch.txt");
    await writeFile(path, "alpha\nbeta\n", "utf8");
    const registry = new ToolRegistry([createPatchFileTool()]);
    const result = await registry.execute(
      call("patch_file", { path: "no-drift-patch.txt", oldText: "alpha", newText: "ALPHA" }),
      contextWithDrift(async () => {}),
    );
    assert.notEqual(result.isError, true, result.content);
    assert.equal(await readFile(path, "utf8"), "ALPHA\nbeta\n");
  });

  it("refuses delete_file when the content changed after the previewed approval", async () => {
    // The preview showed the operator specific content; deleting something else
    // destroys work they never saw.
    const path = join(fixture.workspaceRoot, "drift-delete.txt");
    await writeFile(path, "the content they saw\n", "utf8");
    const registry = new ToolRegistry([createDeleteFileTool()]);
    const result = await registry.execute(
      call("delete_file", { path: "drift-delete.txt" }),
      contextWithDrift(async () => {
        await writeFile(path, "important new work\n", "utf8");
      }),
    );
    assert.equal(result.isError, true, "deleting unreviewed content must be refused");
    assert.equal(await readFile(path, "utf8"), "important new work\n");
  });

  it("still deletes when the content is unchanged", async () => {
    const path = join(fixture.workspaceRoot, "no-drift-delete.txt");
    await writeFile(path, "doomed\n", "utf8");
    const registry = new ToolRegistry([createDeleteFileTool()]);
    const result = await registry.execute(
      call("delete_file", { path: "no-drift-delete.txt" }),
      contextWithDrift(async () => {}),
    );
    assert.notEqual(result.isError, true, result.content);
  });
});
