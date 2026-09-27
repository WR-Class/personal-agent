import { before, describe, it } from "node:test";
import assert from "node:assert/strict";

import { ToolRegistry, createReadFileTool, createCreateFileTool, createDeleteFileTool } from "../src/tools.ts";
import { createTestFixture } from "./fixtures.ts";
import type { ToolContext } from "../src/tools.ts";
import type { ToolCall } from "../src/types.ts";

let fixture: Awaited<ReturnType<typeof createTestFixture>>;

before(async () => {
  fixture = await createTestFixture("capability-set");
});

function call(name: string, args: Record<string, unknown> = {}, id = `call_${name}`): ToolCall {
  return { id, name, arguments: JSON.stringify(args) };
}

function context(): ToolContext {
  return {
    workspaceRoot: fixture.workspaceRoot,
    protectedRoots: [],
    toolEnvironment: undefined,
    readPaths: new Set<string>(),
  } as unknown as ToolContext;
}

function registry(available?: readonly string[]): ToolRegistry {
  return new ToolRegistry(
    [createReadFileTool(), createCreateFileTool(), createDeleteFileTool()],
    available,
  );
}

describe("capability absence", () => {
  it("advertises every tool when no set is given", () => {
    const names = registry().definitions().map((t) => t.name).sort();
    assert.deepEqual(names, ["create_file", "delete_file", "read_file"]);
  });

  it("never advertises a tool the session does not have", () => {
    const names = registry(["read_file"]).definitions().map((t) => t.name);
    assert.deepEqual(names, ["read_file"]);
  });

  it("refuses an absent tool by name instead of executing it", async () => {
    const result = await registry(["read_file"]).execute(call("create_file", { path: "a.txt", content: "x" }), context());
    assert.equal(result.isError, true);
    assert.match(result.content, /not available in this session/);
    assert.match(result.content, /policy boundary/);
  });

  it("tells the model the refusal is standing, not transient", async () => {
    const result = await registry(["read_file"]).execute(call("delete_file", { path: "a.txt" }), context());
    // The distinction is the whole point: a transient error invites a retry.
    assert.match(result.content, /not a transient failure/);
    assert.match(result.content, /policy boundary/);
  });

  it("still executes a tool the session does have", async () => {
    const result = await registry(["read_file", "create_file"]).execute(
      call("read_file", { path: "missing.txt" }),
      context(),
    );
    // It reaches the tool and fails on the real file, not on availability.
    assert.doesNotMatch(result.content, /not available in this session/);
  });

  it("keeps the pre-existing approval gate independent of availability", async () => {
    // create_file is available here, yet still refused because no approval
    // channel exists. Availability and approval are separate axes; a session
    // having a tool must not silently authorise its side effects.
    const result = await registry(["read_file", "create_file"]).execute(
      call("create_file", { path: "kept.txt", content: "hello" }),
      context(),
    );
    assert.equal(result.isError, true);
    assert.match(result.content, /no approval channel is configured/);
  });

  it("reports availability consistently between has() and definitions()", () => {
    const r = registry(["read_file"]);
    assert.equal(r.has("read_file"), true);
    assert.equal(r.has("create_file"), false);
    assert.deepEqual(r.definitions().map((t) => t.name), ["read_file"]);
  });

  it("refuses an availability entry that is not a registered tool", () => {
    assert.throws(() => registry(["read_file", "no_such_tool"]), /available tool is not registered: no_such_tool/);
  });

  it("treats an empty set as no capability rather than as unrestricted", async () => {
    const r = registry([]);
    assert.deepEqual(r.definitions(), []);
    const result = await r.execute(call("read_file", { path: "a.txt" }), context());
    assert.equal(result.isError, true);
    assert.match(result.content, /not available in this session/);
  });
});
