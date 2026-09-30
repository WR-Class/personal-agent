/**
 * Runtime wiring for MCP plugins (M4 路 C, 丙-4): the last slice.
 *
 * `plugin-manifest.ts` (乙-1, extended D123) finds and parses `plugin.json`
 * files. `mcp-client.ts` (丙-2) can spawn one server and speak to it.
 * `mcp-bridge.ts` (丙-3) can turn one server's tools into registry `Tool`s and
 * an `approve` rule. This file is what actually does all three in order, once
 * per session, before `AgentRuntime` is constructed — and gives back one
 * `close()` that shuts every spawned server down together.
 *
 * ## Why this happens before `AgentRuntime` exists, not inside it
 *
 * `AgentRuntime`'s `tools` and `rules` are constructor arguments, not something
 * it can grow after the fact (`runtime.ts` — `this.tools = options.tools`,
 * `this.rules = options.rules`, both set once). Spawning a server and asking it
 * for its tools is inherently asynchronous, and `cli.ts`'s `createRuntime` is a
 * synchronous factory called once per session id. So loading plugins has to be a
 * separate `await` that happens first, producing a flat list of `Tool`s and
 * `Rule`s to fold into the same arrays the built-in tools already populate —
 * from the registry's point of view there is no seam between them at all.
 *
 * ## One broken server does not take down the others, or the session
 *
 * A plugin's `plugin.json` failing to *parse* is a configuration error and stays
 * a hard refusal (`plugin-manifest.ts`'s existing "corrupt means refused"
 * stance — a typo in one manifest must not silently look like "no plugins
 * installed"). But a server that spawns and then fails to *answer* — a missing
 * interpreter, a crashing script, a dependency that was never installed — is an
 * environment fault discovered at run time, not a configuration defect, and it
 * is scoped to that one server. `background-jobs.ts` already treats a command
 * that cannot run as one job's failure, not the whole agent's
 * (`child.on("error", ...)` there writes to that job's own log and settles it;
 * nothing else stops). This file does the equivalent: a server that fails to
 * start or initialize is skipped, its error is collected rather than thrown, and
 * every other server — and every built-in tool — still loads. The caller
 * decides what to do with `errors`; this module never swallows them silently.
 *
 * ponytail: no restart, no health check after the initial handshake, no
 * hot-reload — a plugin's servers are loaded once per session, same as the
 * built-in tool table is built once per session in `cli.ts`.
 */
import { discoverPlugins } from "./plugin-manifest.ts";
import type { McpServerDeclaration, PluginManifest } from "./plugin-manifest.ts";
import { startMcpClient, type McpClient } from "./mcp-client.ts";
import { listMcpTools, mcpBridgeRule, mcpToolToTool } from "./mcp-bridge.ts";
import type { Tool } from "./tools.ts";
import type { Rule } from "./rule-table.ts";
import type { ToolEnvironment } from "./tool-environment.ts";

/** One server that failed to start or hand over its tools. Never thrown — collected. */
export interface McpPluginError {
  readonly pluginName: string;
  readonly serverName: string;
  readonly message: string;
}

export interface LoadedMcpPlugins {
  readonly tools: readonly Tool[];
  readonly rules: readonly Rule[];
  readonly errors: readonly McpPluginError[];
  /** Close every spawned server. Safe to call even when `tools` is empty. */
  close(): void;
}

const EMPTY: LoadedMcpPlugins = { tools: [], rules: [], errors: [], close() {} };

/**
 * Discover every plugin in the agent home, spawn each declared MCP server, and
 * bridge its tools. Returns immediately with an empty result if there are no
 * plugins or none declare `mcpServers` — the state every installation is in
 * today, matching `plugin-manifest.ts`'s own "missing means none" stance.
 *
 * A manifest that fails to *parse* still throws (`discoverPlugins`'s existing
 * behaviour, unchanged): that is a configuration defect, not a runtime one, and
 * this function does not weaken that. Only servers that spawn and then fail are
 * caught and reported through `errors`.
 */
export async function loadMcpPlugins(agentHome: string, environment: ToolEnvironment): Promise<LoadedMcpPlugins> {
  const manifests = await discoverPlugins(agentHome);
  const withServers = manifests.filter((manifest) => manifest.mcpServers !== undefined);
  if (withServers.length === 0) return EMPTY;

  const tools: Tool[] = [];
  const rules: Rule[] = [];
  const errors: McpPluginError[] = [];
  const clients: McpClient[] = [];

  for (const manifest of withServers) {
    for (const [serverName, declaration] of Object.entries(manifest.mcpServers!)) {
      const loaded = await loadOneServer(manifest, serverName, declaration, environment);
      if (loaded.ok) {
        clients.push(loaded.client);
        tools.push(...loaded.tools);
        rules.push(...loaded.rules);
      } else {
        errors.push({ pluginName: manifest.name, serverName, message: loaded.message });
      }
    }
  }

  return {
    tools,
    rules,
    errors,
    close() {
      for (const client of clients) client.close();
    },
  };
}

type ServerLoadResult =
  | { readonly ok: true; readonly client: McpClient; readonly tools: readonly Tool[]; readonly rules: readonly Rule[] }
  | { readonly ok: false; readonly message: string };

/**
 * Spawn one server, initialize it, list its tools, and bridge each one.
 *
 * Every failure path closes the client it opened before returning: a server
 * that answered `initialize` but then failed `tools/list` must not be left
 * running with nothing referencing it, which would be exactly the kind of
 * un-tracked child process `mcp-client.ts`'s own header explains this whole
 * design avoids.
 *
 * ⚠️ The `{ ...environment, cwd: ... }` spread below deliberately does not go
 * through `requireToolEnvironment`'s identity check (`isIssuedToolEnvironment`,
 * `tools.ts`) — that check guards `ToolContext.toolEnvironment`, a value a tool's
 * own `execute` reads and that must be provably the runtime's own object, never a
 * forged lookalike. `startMcpClient`'s second argument is a different thing: a
 * plain value this module builds once, before any `ToolContext` exists, to spawn
 * a process. If `mcp-client.ts` ever starts requiring an issued environment, this
 * derived copy would need `buildToolEnvironment` called again with the same
 * inputs plus `cwd`, not a spread of an already-issued one.
 *
 * ⚠️ **The default `cwd` is the plugin's own directory (`manifest.root`), not the
 * caller's workspace — this was found by a real spawn failing, not by reading.**
 * The first version of this function left `cwd` at the caller's `environment`
 * (the operator's workspace root) unless a declaration overrode it, and a script
 * launched with a manifest-relative `args` path like `"server/server.mjs"`
 * immediately exited — Node resolved that path against the workspace, not the
 * plugin directory, and found nothing there. A plugin's own files are naturally
 * relative to its own directory, the same way `plugin-manifest.ts`'s `cwd` field
 * already resolves and contains paths against `manifest.root`; defaulting the
 * process's actual working directory to anywhere else made every relative path a
 * plugin writes wrong by default. `declaration.cwd`, already validated to resolve
 * inside `manifest.root`, can still narrow it to a subdirectory.
 */
async function loadOneServer(
  manifest: PluginManifest,
  serverName: string,
  declaration: McpServerDeclaration,
  environment: ToolEnvironment,
): Promise<ServerLoadResult> {
  const spawnEnvironment: ToolEnvironment = { ...environment, cwd: declaration.cwd ?? manifest.root };
  const client = startMcpClient({ command: declaration.command, ...(declaration.args ? { args: declaration.args } : {}) }, spawnEnvironment);
  try {
    await client.initialize(`personal-agent-plugin:${manifest.name}`);
    const infos = await listMcpTools(client);
    const tools = infos.map((info) => mcpToolToTool(`${manifest.name}.${serverName}`, info, client));
    const rules = tools.map((tool) => mcpBridgeRule(tool.name));
    return { ok: true, client, tools, rules };
  } catch (error) {
    client.close();
    return { ok: false, message: (error as Error).message };
  }
}
