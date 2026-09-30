/**
 * Plugin discovery and manifest parsing (M4, D118 — 乙-1).
 *
 * Two kinds of assertion, the same split as skill-catalogue.test.ts:
 * - Parse-level: every refusal branch of parsePluginManifest, because a loader
 *   that degrades on a corrupt manifest is indistinguishable from one that found
 *   no plugin — the wrong thing to tell someone who installed one.
 * - Disk-level: discoverPlugins over a real agent home, proving discovery, the
 *   skip-non-plugin rule, duplicate refusal, and path containment against the
 *   filesystem rather than a hand-built string.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  PLUGIN_MANIFEST_VERSION,
  discoverPlugins,
  parsePluginManifest,
  pluginsDir,
} from "../src/plugin-manifest.ts";
import { createTestFixture } from "./fixtures.ts";

// A fixed fake root for parse-level tests. The directory need not exist for
// parsing itself; only containedPath resolves paths, and it resolves relative to
// this root without requiring it on disk (canonicalPath tolerates missing leaves).
const ROOT = join("C:", "fake", "agent-home", "plugins", "demo");
const FILE = join(ROOT, "plugin.json");

function parses(obj: unknown) {
  return parsePluginManifest(JSON.stringify(obj), FILE, ROOT);
}

function refuses(obj: unknown, pattern: RegExp) {
  assert.throws(() => parses(obj), pattern, `应当拒绝：${JSON.stringify(obj).slice(0, 120)}`);
}

async function writePlugin(home: string, dir: string, manifest: unknown): Promise<void> {
  const root = join(pluginsDir(home), dir);
  await mkdir(root, { recursive: true });
  await writeFile(join(root, "plugin.json"), JSON.stringify(manifest), "utf8");
}

describe("plugin manifest", () => {
  it("parses a minimal valid manifest", () => {
    const m = parses({ name: "demo", version: "1.0.0" });
    assert.equal(m.name, "demo");
    assert.equal(m.version, "1.0.0");
    assert.equal(m.root, ROOT);
    assert.equal(m.toolsDir, undefined);
  });

  it("resolves a contained tools directory to an absolute path inside the plugin", () => {
    const m = parses({ name: "demo", version: "1.0.0", tools: "tools" });
    assert.equal(m.toolsDir, join(ROOT, "tools"));
  });

  it("refuses non-object, non-JSON, and array top levels", () => {
    assert.throws(() => parsePluginManifest("{not json", FILE, ROOT), /不是合法 JSON/);
    assert.throws(() => parsePluginManifest("[]", FILE, ROOT), /顶层必须是一个对象/);
    assert.throws(() => parsePluginManifest("42", FILE, ROOT), /顶层必须是一个对象/);
  });

  it("refuses a permission key with a message pointing at the right file", () => {
    for (const key of ["tool", "decision", "tier", "rules", "when", "allow", "deny", "trust"]) {
      refuses({ name: "demo", version: "1.0.0", [key]: "x" }, /不能改权限/);
    }
  });

  it("refuses an unknown field rather than ignoring it", () => {
    refuses({ name: "demo", version: "1.0.0", mcpServers: {} }, /含未知字段/);
  });

  it("refuses a missing or blank name and version", () => {
    refuses({ version: "1.0.0" }, /缺 name/);
    refuses({ name: "", version: "1.0.0" }, /name 是空字符串/);
    refuses({ name: "demo" }, /缺 version/);
    refuses({ name: "demo", version: "  " }, /version 是空字符串/);
  });

  it("refuses a name that disagrees with its directory", () => {
    // basename(ROOT) is "demo"; a manifest naming itself otherwise is refused.
    refuses({ name: "other", version: "1.0.0" }, /与所在目录名.*不一致/);
  });

  it("refuses a tools path that escapes the plugin directory", () => {
    refuses({ name: "demo", version: "1.0.0", tools: "../elsewhere" }, /指向插件目录之外/);
    refuses({ name: "demo", version: "1.0.0", tools: join("C:", "abs") }, /必须是相对路径/);
  });

  it("treats a missing plugins directory as no plugins", async () => {
    const fixture = await createTestFixture("plugin-none");
    assert.deepEqual(await discoverPlugins(fixture.home), []);
  });

  it("discovers plugins and skips directories without a manifest", async () => {
    const fixture = await createTestFixture("plugin-discover");
    await writePlugin(fixture.home, "alpha", { name: "alpha", version: "1.0.0" });
    await writePlugin(fixture.home, "beta", { name: "beta", version: "2.1.0", tools: "tools" });
    // A directory with no plugin.json is not a plugin.
    await mkdir(join(pluginsDir(fixture.home), "not-a-plugin"), { recursive: true });
    const found = await discoverPlugins(fixture.home);
    assert.deepEqual(found.map((p) => p.name), ["alpha", "beta"], "按名字排序，跳过无清单的目录");
    assert.equal(found[1]?.toolsDir, join(pluginsDir(fixture.home), "beta", "tools"));
  });

  it("name uniqueness comes from name-equals-directory, so a mismatched copy is refused", async () => {
    // There is no separate duplicate-name guard, on purpose: name === basename(dir)
    // plus unique directory names already makes names unique. This pins the
    // reasoning — a second plugin trying to claim an existing name must sit in a
    // differently-named directory, and the agreement check refuses it there.
    const fixture = await createTestFixture("plugin-dup");
    await writePlugin(fixture.home, "gamma", { name: "gamma", version: "1.0.0" });
    await writePlugin(fixture.home, "gamma-copy", { name: "gamma", version: "1.0.0" });
    await assert.rejects(() => discoverPlugins(fixture.home), /与所在目录名.*不一致/);
  });

  it("throws on a malformed manifest rather than skipping it", async () => {
    const fixture = await createTestFixture("plugin-broken");
    const root = join(pluginsDir(fixture.home), "broken");
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "plugin.json"), "{ broken", "utf8");
    await assert.rejects(() => discoverPlugins(fixture.home), /不是合法 JSON/);
  });

  it("version constant is exported", () => {
    assert.equal(PLUGIN_MANIFEST_VERSION, 1);
  });
});
