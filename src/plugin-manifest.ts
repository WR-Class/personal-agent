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
 * The ceiling is that a manifest is a name, a version, and the MCP servers it
 * declares; this file stops at "the manifest is well-formed", never spawning
 * anything itself — that is 丙-4's runtime wiring (`mcp-plugin.ts`), which reads
 * what this file parses.
 *
 * ⚠️ **D122 correction**: an earlier revision of this file (D118, 乙-1) had a
 * `tools` / `toolsDir` field for a prose-skill "second SkillProvider" plan (路 乙).
 * The operator chose to go straight to 路 丙 (`REFERENCE_DECISIONS.md` §12.5) and
 * that field was never read by anything — 乙 was never built. Removed rather than
 * left in place: a field with no reader is a promise the code does not keep, and
 * `mcpServers` below is what the manifest actually needs to express for 丙.
 *
 * ⚠️ **A manifest that declares `mcpServers` is declaring what to *execute*, which
 * is a step up from D118's pure-data-only claim.** This file still parses without
 * running anything — spawning is 丙-4's job, not this file's — but it is worth
 * being honest that `command`/`args` here name a program the runtime will later
 * spawn unsandboxed (路 C's whole model, `mcp-client.ts`'s header). The mitigating
 * fact is unchanged from D118: `plugin.json` lives in the agent home, which
 * `protectedRoots` already keeps outside every write tool's reach (`runtime.ts`,
 * D50) — a model cannot write itself a new MCP server to spawn, only an operator
 * placing the file by hand can.
 */
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";

import { canonicalPath, isWithin } from "./security-config.ts";

export const PLUGIN_MANIFEST_VERSION = 1;

/** The manifest filename inside each plugin directory. */
export const PLUGIN_MANIFEST_NAME = "plugin.json";

/**
 * One MCP server a plugin declares. `command` is resolved by the OS the same way
 * any spawned program is (PATH lookup included) — this is not a path checked for
 * containment, because it names a *program*, not a file inside the plugin
 * directory. `cwd` is the one path-shaped field here, and it IS checked to stay
 * inside the plugin's own root, for the same reason `tools` was in D118: a
 * server's working directory is the one thing this manifest can place under the
 * plugin's own tree rather than pointing anywhere on disk.
 */
export interface McpServerDeclaration {
  readonly command: string;
  readonly args?: readonly string[];
  /** Absolute, canonical, and proven inside the plugin root. Optional. */
  readonly cwd?: string;
}

/**
 * A parsed plugin manifest. Deliberately minimal (adoption ① — convention-first,
 * tiny manifest): identity plus the MCP servers it declares.
 *
 * `root` is the absolute, canonical plugin directory, added by the loader rather
 * than read from the file — a manifest cannot name its own location.
 */
export interface PluginManifest {
  readonly name: string;
  readonly version: string;
  /** Absolute canonical directory this plugin lives in. Loader-supplied. */
  readonly root: string;
  /** Keyed by the server's name within this plugin — see `parseMcpServers`. */
  readonly mcpServers?: Readonly<Record<string, McpServerDeclaration>>;
}

/** Fields a manifest may carry. Anything else is refused, not ignored. */
const MANIFEST_KEYS: readonly string[] = ["name", "version", "mcpServers"];

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

  const mcpServers = record.mcpServers === undefined ? undefined : parseMcpServers(record.mcpServers, file, root);

  return mcpServers === undefined ? { name, version, root } : { name, version, root, mcpServers };
}

/**
 * Parse the `mcpServers` object: a map of server name to declaration. Keyed by
 * name (rather than an array) for the same reason `skills.json`'s duplicate-id
 * refusal exists — a JSON object cannot itself carry two keys with the same
 * string, so uniqueness within one manifest is a property of the format rather
 * than a check this code has to perform.
 */
function parseMcpServers(value: unknown, file: string, root: string): Readonly<Record<string, McpServerDeclaration>> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file} 的 mcpServers 必须是一个对象，形如 {"服务名":{"command":"…"}}`);
  }
  const record = value as Record<string, unknown>;
  const names = Object.keys(record);
  if (names.length === 0) {
    throw new Error(`${file} 的 mcpServers 是空对象；不声明服务器就删掉这个字段`);
  }
  const servers: Record<string, McpServerDeclaration> = {};
  for (const serverName of names) {
    if (serverName.trim() === "") throw new Error(`${file} 的 mcpServers 含空字符串键名`);
    servers[serverName] = parseMcpServerDeclaration(record[serverName], file, root, serverName);
  }
  return servers;
}

function parseMcpServerDeclaration(value: unknown, file: string, root: string, serverName: string): McpServerDeclaration {
  const where = `mcpServers[${JSON.stringify(serverName)}]`;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${file} 的 ${where} 必须是一个对象，形如 {"command":"…"}`);
  }
  const record = value as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (!["command", "args", "cwd"].includes(key)) {
      throw new Error(`${file} 的 ${where} 含未知字段 ${JSON.stringify(key)}（只接受 command、args、cwd）`);
    }
  }
  const command = requireString(record.command, `${file} 的 ${where} 缺 command 或 command 不是字符串`);
  if (command.trim() === "") throw new Error(`${file} 的 ${where} 的 command 是空字符串`);

  let args: readonly string[] | undefined;
  if (record.args !== undefined) {
    if (!Array.isArray(record.args) || record.args.some((item) => typeof item !== "string")) {
      throw new Error(`${file} 的 ${where} 的 args 必须是字符串数组`);
    }
    args = record.args as readonly string[];
  }

  let cwd: string | undefined;
  if (record.cwd !== undefined) {
    const rel = requireString(record.cwd, `${file} 的 ${where} 的 cwd 必须是字符串（相对插件目录的路径）`);
    cwd = containedPath(root, rel, file, `${where}.cwd`);
  }

  return { command, ...(args === undefined ? {} : { args }), ...(cwd === undefined ? {} : { cwd }) };
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
