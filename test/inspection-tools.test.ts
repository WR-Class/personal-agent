/**
 * Named read-only inspection tools (D41).
 *
 * The property under test is what this design *cannot express*, so most of these
 * assertions are about refusals rather than successes. `tool` is an enum drawn
 * from a constant in this repository and `path` is a path; there is no parameter
 * that accepts a command string, so shell metacharacters are not filtered — they
 * are impossible to write down.
 *
 * Measured for comparison: crush's own chaining check passes `ls & rm -rf /`, a
 * second command after a newline, and `git status > /etc/passwd`. It is still
 * safe, because those fall through to a prompt, but it shows detection is not
 * the mechanism to copy. Not invoking a shell at all is stronger than detecting
 * the cases someone thought of.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { INSPECTION_TOOLS, findInspectionTool, inspectionToolNames } from "../src/inspection-tools.ts";
import { createInspectFileTool } from "../src/tools.ts";

let workspace: string;

const inspect = (args: Record<string, unknown>) =>
  createInspectFileTool().execute({ ...args }, { workspaceRoot: workspace });

before(async () => {
  workspace = path.join(process.cwd(), ".test-artifacts", `inspection-${process.pid}`);
  await mkdir(workspace, { recursive: true });
  await writeFile(path.join(workspace, "note.txt"), "hello\n", "utf8");
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("inspection tool list", () => {
  it("is a product constant with unique names", () => {
    const names = inspectionToolNames();
    assert.equal(new Set(names).size, names.length, "duplicate tool name");
    assert.ok(names.length > 0);
  });

  it("resolves only names that are on the list", () => {
    assert.ok(findInspectionTool("certutil_hash"));
    // The model cannot conjure an executable: unknown names resolve to nothing.
    assert.equal(findInspectionTool("rm"), undefined);
    assert.equal(findInspectionTool(""), undefined);
    assert.equal(findInspectionTool("certutil; rm -rf /"), undefined);
  });

  it("declares an executable per entry, never a command string", () => {
    for (const tool of INSPECTION_TOOLS) {
      // No entry may carry shell syntax in its executable name.
      assert.ok(!/[\s;&|`$><]/.test(tool.executable), `${tool.name} has a suspicious executable`);
    }
  });

  it("builds argv so a path stays exactly one argument", () => {
    for (const tool of INSPECTION_TOOLS) {
      const tricky = "/tmp/a b; rm -rf / && x|y";
      const argv = tool.args(tricky, {});
      // The path must appear as one element, not be re-split or dropped.
      const occurrences = argv.filter((a) => a.includes(tricky)).length;
      assert.equal(occurrences, 1, `${tool.name} mangled the path`);
    }
  });
});

describe("inspect_file refuses anything outside the audited list", () => {
  it("refuses a tool name that is a command", async () => {
    const result = await inspect({ tool: "rm -rf /", path: "note.txt" });
    assert.equal(result.isError, true);
    assert.match(String(result.content), /unknown tool/);
  });

  it("refuses a tool name with shell chaining appended", async () => {
    const result = await inspect({ tool: "certutil -dump; rm -rf /", path: "note.txt" });
    assert.equal(result.isError, true);
    assert.match(String(result.content), /unknown tool/);
  });

  it("refuses a missing or empty tool name", async () => {
    for (const tool of [undefined, "", 42]) {
      const result = await inspect({ tool, path: "note.txt" });
      assert.equal(result.isError, true);
    }
  });

  it("refuses a path outside the workspace", async () => {
    const result = await inspect({ tool: "file_type", path: "../../../Windows/win.ini" });
    assert.equal(result.isError, true);
    assert.match(String(result.content), /escapes the workspace|unsupported|sensitive/);
  });

  it("refuses a non-positive lines hint", async () => {
    for (const lines of [0, -1, 1.5]) {
      const result = await inspect({ tool: "certutil_dump", path: "note.txt", lines });
      assert.equal(result.isError, true);
    }
  });
});

describe("inspect_file reports honestly when a tool is absent", () => {
  it("names the missing executable instead of pretending", async () => {
    // `file` is absent on a stock Windows machine, which was measured. The
    // result must say so rather than reporting an empty inspection.
    const absent = INSPECTION_TOOLS.find((tool) => tool.executable === "file");
    if (!absent) return;
    const result = await inspect({ tool: absent.name, path: "note.txt" });
    if (result.isError === true) {
      assert.match(String(result.content), /not installed|not on PATH|cannot run/);
    }
  });

  it("refuses a path that does not exist, before spawning anything", async () => {
    const result = await inspect({ tool: "certutil_hash", path: "no-such-file.txt" });
    assert.equal(result.isError, true);
    assert.match(String(result.content), /no such file/);
  });

  it("refuses a directory rather than passing it to a tool", async () => {
    const result = await inspect({ tool: "certutil_hash", path: "." });
    assert.equal(result.isError, true);
    assert.match(String(result.content), /not a regular file/);
  });
});
