import { lstatSync, realpathSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Trusted host configuration only; never populate these fields from model arguments. */
export interface PathPolicyOptions {
  env?: NodeJS.ProcessEnv;
  operatorHome?: string;
  /** Additional protected roots; built-in protections cannot be removed. */
  protectedRoots?: readonly string[];
}

export function isWithin(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function cleanPath(value: string): string {
  if (!value.trim() || value.includes("\0")) throw new Error("path must be non-empty and contain no NUL");
  // Windows device/ADS aliases and trailing-dot/space aliases are not supported.
  if (process.platform === "win32" &&
      (/^\\\\[?.]\\/.test(value) || value.slice(2).includes(":") || value.split(/[\\/]/).some(p => p !== "." && p !== ".." && /[. ]$/.test(p)))) {
    throw new Error("unsupported Windows path alias");
  }
  return path.resolve(value);
}

/** Resolve the nearest existing ancestor; missing leaves must not hide a junction. */
export function canonicalPath(value: string): string {
  const absolute = cleanPath(value);
  let cursor = absolute;
  const missing: string[] = [];
  while (true) {
    try { lstatSync(cursor); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      const parent = path.dirname(cursor);
      if (parent === cursor) throw new Error("cannot resolve path root");
      missing.unshift(path.basename(cursor));
      cursor = parent;
      continue;
    }
    // An existing broken link is an error, not a missing leaf fallback.
    return path.resolve(realpathSync.native(cursor), ...missing);
  }
}

export function protectedRoots(options: PathPolicyOptions = {}): string[] {
  const env = options.env ?? process.env;
  const homes = [options.operatorHome, env.USERPROFILE, env.HOME, os.homedir()].filter((v): v is string => !!v);
  const roots = [process.env.DSH_HOME, env.DSH_HOME, ...homes.map(h => path.join(h, ".dsh")),
    ...homes.map(h => path.join(h, "DSH-Backup")), ...(options.protectedRoots ?? [])];
  if (process.platform === "win32") {
    for (const e of [process.env, env]) roots.push(e.SystemRoot, e.windir, e.ProgramFiles,
      e["ProgramFiles(x86)"], e.ProgramData, e.APPDATA, e.LOCALAPPDATA);
  }
  return [...new Set(roots.filter((r): r is string => !!r).map(canonicalPath))];
}

export function assertSafeStateDirectory(value: string, options: PathPolicyOptions = {}): string {
  const candidate = canonicalPath(value);
  if (path.dirname(candidate) === candidate) throw new Error("refuses filesystem root");
  const env = options.env ?? process.env;
  for (const home of [os.homedir(), options.operatorHome, env.USERPROFILE, env.HOME].filter((v): v is string => !!v)) {
    const operator = canonicalPath(home);
    if (candidate === operator) throw new Error("refuses operator's home directory");
    if (isWithin(candidate, operator)) throw new Error("refuses directory that contains the operator's home directory");
  }
  for (const root of protectedRoots(options)) {
    if (isWithin(root, candidate) || isWithin(candidate, root)) throw new Error("refuses protected host or backup directory");
  }
  return candidate;
}

export interface RuntimePaths {
  readonly workspaceRoot: string;
  readonly agentHome: string;
  readonly scratch: string;
  readonly protectedRoots: readonly string[];
}

export function resolveRuntimePaths(options: PathPolicyOptions & {
  workspaceRoot: string; agentHome: string; tempRoot?: string;
}): RuntimePaths {
  const agentHome = assertSafeStateDirectory(options.agentHome, options);
  const scratch = assertSafeStateDirectory(options.tempRoot ?? path.join(agentHome, "tmp"), options);
  if (scratch === agentHome || !isWithin(agentHome, scratch)) throw new Error("scratch must be strictly inside agent home");
  return Object.freeze({ workspaceRoot: canonicalPath(options.workspaceRoot), agentHome, scratch,
    protectedRoots: Object.freeze(protectedRoots(options)) });
}

export function configuredProtectedRoots(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PERSONAL_AGENT_PROTECTED_ROOTS;
  if (raw === undefined) return [];
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || parsed.some(v => typeof v !== "string" || !v.trim() || !path.isAbsolute(v))) {
    throw new Error("PERSONAL_AGENT_PROTECTED_ROOTS must be a JSON array of absolute paths");
  }
  return parsed as string[];
}

/**
 * Per-model prompt windows from `PERSONAL_AGENT_CONTEXT_WINDOWS`.
 *
 * A JSON object of `{"<model>": <tokens>}`; `"*"` is the fallback for any model
 * without an exact entry. Rejecting a bad value here (rather than at first use)
 * matters: a silently ignored window would leave the model unguarded while
 * looking configured.
 */
export function configuredContextWindows(env: NodeJS.ProcessEnv): Record<string, number> | undefined {
  const raw = env.PERSONAL_AGENT_CONTEXT_WINDOWS;
  if (raw === undefined || !raw.trim()) return undefined;
  const parsed: unknown = JSON.parse(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("PERSONAL_AGENT_CONTEXT_WINDOWS must be a JSON object of model name to token count");
  }
  const windows: Record<string, number> = {};
  for (const [model, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!model.trim()) throw new Error("PERSONAL_AGENT_CONTEXT_WINDOWS keys must be non-empty model names");
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`PERSONAL_AGENT_CONTEXT_WINDOWS["${model}"] must be a positive integer token count`);
    }
    windows[model] = value;
  }
  return Object.keys(windows).length ? windows : undefined;
}

/** Deny before read and after canonicalization. Error never includes file contents. */
export function assertReadablePath(target: string, workspace: string, extraRoots: readonly string[] = []): string {
  const lexical = cleanPath(target);
  const actual = canonicalPath(lexical);
  const root = canonicalPath(workspace);
  if (!isWithin(root, actual)) throw new Error("path escapes the workspace");
  for (const denied of [...protectedRoots(), ...extraRoots.map(canonicalPath)]) {
    if (isWithin(denied, actual) || isWithin(denied, lexical)) throw new Error("sensitive path is denied");
  }
  const sensitive = (p: string) => p.split(/[\\/]/).some(part =>
    /^(?:\.env(?:\..*)?|provider-config\.json|\.dsh|\.personal-agent|\.ssh|\.aws|\.azure|\.kube|\.gnupg|\.git|\.npmrc|\.pypirc|credentials(?:\..*)?|\.credentials(?:\..*)?|secrets?(?:\..*)?|id_(?:rsa|dsa|ecdsa|ed25519)(?:\..*)?|.*\.(?:pem|key|p12|pfx))$/i.test(part));
  // Selecting a sensitive directory as workspace must not remove its protection.
  if (sensitive(lexical) || sensitive(actual)) throw new Error("sensitive path is denied");
  return actual;
}
