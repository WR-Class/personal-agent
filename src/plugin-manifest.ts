/**
 * Plugin discovery and manifest parsing (M4, D118 — 乙-1).
 *
 * The first slice of M4's plugin system: find plugins in the agent home and
 * parse their manifests. **Pure data, zero execution.** Nothing here runs a
 * plugin, registers a tool, or starts a process — that is 乙-2 and beyond. This
 * file only answers "what plugins are installed and what do they claim to be".
 *
 * The shape is `skill-catalogue.ts`'s on purpose, and inherits its threat model:
 *
 * - **Only the agent home is ever read.** A plugin lives at
 *   `<agentHome>/plugins/<name>/plugin.json`. There is deliberately no search of
 *   the workspace — the same rejection `skill-catalogue.ts:10-17` records of
 *   WorkBuddy's second level: a cloned repository must not be able to ship a
 *   plugin that ends up contributing tools or prompts. The M4 investigation
 *   (`REFERENCE_DECISIONS.md` §12.4) records this as an explicit rejection, and it
 *   is stricter than all three products read there.
 * - **Corrupt means refused, never degraded.** A malformed manifest throws with
 *   the file and the reason. Reading it as absent would tell an operator who
 *   believes they installed a plugin that they have none — the decision already
 *   made for `trust.json`, `constraints.json`, and `skills.json`.
 * - **Path containment is enforced, not hoped for.** Any path a manifest names is
 *   checked to stay inside the plugin's own directory: no absolute path, no `..`,
 *   no symlink escape. This is adoption ③ of the M4 investigation — the one
 *   defence every reference product that had any file protection implemented.
 *
 * ponytail: no marketplace, no dependencies, no version ranges, no auto-update.
 * The ceiling is that a manifest is a name, a version, and a list of the
 * directories it contributes. Contribution *discovery* (skills/, tools/) is later
 * slices; this file stops at "the manifest is well-formed and its paths are
 * contained".
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { canonicalPath, isWithin } from "./security-config.ts";

export const PLUGIN_MANIFEST_VERSION = 1;

/** The manifest filename inside each plugin directory. */
export const PLUGIN_MANIFEST_NAME = "plugin.json";

/**
 * A parsed plugin manifest. Deliberately minimal (adoption ① — convention-first,
 * tiny manifest): only identity and the optional directories it contributes.
 *
 * `root` is the absolute, canonical plugin directory, added by the loader rather
 * than read from the file — a manifest cannot name its own location. Contribution
 * directories are stored relative and validated to resolve inside `root`.
 */
export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  /** Absolute canonical directory this plugin lives in. Loader-supplied. */
  readonly root: string;
  /** Directory of read-only tool definitions this plugin contributes (乙-2). */
  readonly toolsDir?: string;
}

/** Fields a manifest may carry. Anything else is refused, not ignored. */
const MANIFEST_KEYS: readonly string[] = ["name", "version", "tools"];

/**
 * Keys that would be an attempt to widen permissions from a plugin manifest.
 * Given a dedicated refusal pointing at the file that does handle permissions,
 * the same reasoning as `skill-catalogue.ts:71-88`.
 */
const PERMISSION_KEYS: readonly string[] = ["tool", "decision", "tier", "rules", "when", "allow", "deny", "trust"];

/** The plugins root inside an agent home. */
export function pluginsDir(agentHome: string): string {
  return path.join(agentHome, "plugins");
}

/**
 * Discover every plugin under the agent home and parse its manifest.
 *
 * A missing `plugins/` directory is normal and yields none — the state every
 * installation is in today. A directory without a `plugin.json` is skipped (it is
 * not a plugin), but a `plugin.json` that fails to parse throws: a broken plugin
 * an operator installed must not be silently ignored.
 */
export async function discoverPlugins(agentHome: string): Promise<readonly PluginManifest[]> {
  const dir = pluginsDir(agentHome);
  let entries: string[];
  try {
    entries = (await readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const manifests: PluginManifest[] = [];
  for (const entry of entries.sort()) {
    const root = canonicalPath(path.join(dir, entry));
    const file = path.join(root, PLUGIN_MANIFEST_NAME);
    let text: string;
    try {
      text = await readFile(file, "utf8");
    } catch (error) {
      // No manifest ⇒ not a plugin, skip. Any other read error is real.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw error;
    }
    // ⚠️ Uniqueness of names comes free: parsePluginManifest requires
    // `name === basename(root)`, and directory names under one parent are already
    // unique, so two plugins cannot share a name. A separate duplicate-name guard
    // would be unreachable code — the name/directory agreement check IS the
    // uniqueness guarantee, and this is where that reasoning is recorded so no one
    // adds the dead guard back.
    manifests.push(parsePluginManifest(text, file, root));
  }
  return manifests;
}

export function parsePluginManifest(text: string, file: string, root: string): PluginManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(`${file} 不是合法 JSON；插件没有被加载`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${file} 顶层必须是一个对象，形如 {"name":"…","version":"…"}`);
  }
  const record = parsed as Record<string, unknown>;
  // Checked before the generic unknown-field loop so the operator is pointed at
  // the file that does handle permissions, rather than told the key is a typo.
  for (const key of PERMISSION_KEYS) {
    if (key in record) throw permissionError(file, key);
  }
  for (const key of Object.keys(record)) {
    if (!MANIFEST_KEYS.includes(key)) {
      throw new Error(`${file} 含未知字段 ${JSON.stringify(key)}（只接受 ${MANIFEST_KEYS.join("、")}）`);
    }
  }

  const name = requireString(record.name, `${file} 缺 name 或 name 不是字符串`);
  if (name.trim() === "") throw new Error(`${file} 的 name 是空字符串`);
  // The plugin directory name and the manifest name must agree: the directory is
  // how it is found, the name is how it is referenced, and a mismatch means an
  // audit line naming the plugin cannot be traced back to a directory.
  if (name !== path.basename(root)) {
    throw new Error(`${file} 的 name ${JSON.stringify(name)} 与所在目录名 ${JSON.stringify(path.basename(root))} 不一致；两者必须相同`);
  }

  const version = requireString(record.version, `${file} 缺 version 或 version 不是字符串`);
  if (version.trim() === "") throw new Error(`${file} 的 version 是空字符串`);

  let toolsDir: string | undefined;
  if (record.tools !== undefined) {
    const rel = requireString(record.tools, `${file} 的 tools 必须是字符串（相对插件目录的路径）`);
    toolsDir = containedPath(root, rel, file, "tools");
  }

  return toolsDir === undefined ? { name, version, root } : { name, version, root, toolsDir };
}

/**
 * Resolve a manifest-declared relative path and prove it stays inside the plugin
 * root. Rejects absolute paths, `..` escapes, and symlink escapes (the resolve is
 * canonical). This is the containment defence adoption ③ names.
 */
function containedPath(root: string, rel: string, file: string, field: string): string {
  if (path.isAbsolute(rel)) {
    throw new Error(`${file} 的 ${field} 必须是相对路径，不能是绝对路径：${JSON.stringify(rel)}`);
  }
  const resolved = canonicalPath(path.join(root, rel));
  if (!isWithin(root, resolved)) {
    throw new Error(`${file} 的 ${field} 指向插件目录之外：${JSON.stringify(rel)}（插件不得贡献自己目录以外的路径）`);
  }
  return resolved;
}

function requireString(value: unknown, message: string): string {
  if (typeof value !== "string") throw new Error(message);
  return value;
}

function permissionError(file: string, key: string): Error {
  return new Error(
    `${file} 含 ${JSON.stringify(key)}：插件清单不能改权限。` +
      `工具的放宽或收紧由权限档位与 config.json 决定（它会逐条审计放宽项）`,
  );
}
