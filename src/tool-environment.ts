import path from "node:path";
import { assertSafeStateDirectory, resolveRuntimePaths, isWithin } from "./security-config.ts";
import type { PathPolicyOptions } from "./security-config.ts";

/** Cooperative context for trusted tools, NOT an OS sandbox or a changed process identity. */
export interface ToolEnvironment {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
}
export class UnsafeAgentHomeError extends Error {
  constructor(message: string) { super(message); this.name = "UnsafeAgentHomeError"; }
}
export interface AgentHomeCheck extends PathPolicyOptions {}

export function agentHomeProblem(home: string, check: AgentHomeCheck = {}): string | null {
  try { assertSafeStateDirectory(home, check); return null; }
  catch (error) { return error instanceof Error ? error.message : String(error); }
}
export function assertSafeAgentHome(home: string, check: AgentHomeCheck = {}): void {
  const problem = agentHomeProblem(home, check);
  if (problem !== null) throw new UnsafeAgentHomeError(problem);
}
export interface ToolEnvironmentOptions {
  workspaceRoot: string;
  agentHome: string;
  tempRoot?: string;
  operatorHome?: string;
  base?: NodeJS.ProcessEnv;
  protectedRoots?: readonly string[];
}

const ALLOWED = new Map([
  ["PATH", "PATH"], ["SYSTEMROOT", "SystemRoot"], ["WINDIR", "WINDIR"],
  ["COMSPEC", "ComSpec"], ["PATHEXT", "PATHEXT"],
  ["LANG", "LANG"], ["LC_ALL", "LC_ALL"], ["LC_CTYPE", "LC_CTYPE"],
  ["TERM", "TERM"], ["COLORTERM", "COLORTERM"], ["NO_COLOR", "NO_COLOR"],
]);
const issued = new WeakSet<object>();
/** Reject forged mutable dictionaries at the cooperative tool boundary. */
export function isIssuedToolEnvironment(value: ToolEnvironment): boolean { return issued.has(value); }

export function buildToolEnvironment(options: ToolEnvironmentOptions): ToolEnvironment {
  let paths;
  try {
    paths = resolveRuntimePaths({ workspaceRoot: options.workspaceRoot, agentHome: options.agentHome,
      tempRoot: options.tempRoot, env: options.base, operatorHome: options.operatorHome,
      protectedRoots: options.protectedRoots });
  } catch (error) { throw new UnsafeAgentHomeError((error as Error).message); }
  const base = options.base ?? process.env;
  const env: Record<string, string> = {};
  for (const [name, value] of Object.entries(base)) {
    const key = ALLOWED.get(process.platform === "win32" ? name.toUpperCase() : name);
    if (key && value !== undefined) env[key] = value;
  }
  const home = paths.agentHome;
  const childDirectory = (...segments: string[]) => {
    try {
      const candidate = assertSafeStateDirectory(path.join(home, ...segments), {
        env: base, operatorHome: options.operatorHome, protectedRoots: options.protectedRoots });
      if (candidate === home || !isWithin(home, candidate)) throw new Error("configuration directory escapes agent home");
      return candidate;
    } catch (error) { throw new UnsafeAgentHomeError((error as Error).message); }
  };
  Object.assign(env, {
    HOME: home, USERPROFILE: home, TMP: paths.scratch, TEMP: paths.scratch, TMPDIR: paths.scratch,
    APPDATA: childDirectory("AppData", "Roaming"), LOCALAPPDATA: childDirectory("AppData", "Local"),
    XDG_CONFIG_HOME: childDirectory("config"), XDG_CACHE_HOME: childDirectory("cache"),
    XDG_DATA_HOME: childDirectory("data"),
  });
  if (process.platform === "win32") {
    const root = path.parse(home).root;
    env.HOMEDRIVE = root.replace(/[\\/]$/, "");
    env.HOMEPATH = home.slice(env.HOMEDRIVE.length);
  }
  const result = Object.freeze({ cwd: paths.workspaceRoot, env: Object.freeze(env) });
  issued.add(result);
  return result;
}
