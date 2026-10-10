/**
 * Server operations via ssh (D51).
 *
 * Two tools here, both built on `approveExact` so the tier and the rule table
 * decide when asking happens. The point of this file is what it cannot do:
 * none of these tools run a command from inside the agent — they spawn the
 * platform's `ssh` and ask it to. The shell is the operator's shell, with the
 * operator's host key, so the trust boundary is the ssh invocation itself,
 * not whatever runs after it.
 *
 * Configuration lives in the agent home (read-only for the agent):
 *   <home>/infra-hosts.json        {"hosts": {"<host>": {"user": "root", "port": 22, "key": "<host>.pem"}}}
 *   <home>/infra-keys/<key>         the private key in PEM/OpenSSH form, mode 600
 *
 * The agent does not write to either, does not log the key, and does not pass
 * the command on its own command line — the command is the ssh argument, so a
 * request that has been approved once is the request that runs.
 */
import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { Tool, ToolContext, ToolResult } from "./tools.ts";
import { approveExact } from "./tools.ts";

const SSH_MAX_OUTPUT_BYTES = 256 * 1024;
const SSH_TIMEOUT_MS = 60_000;

interface HostEntry {
  readonly user: string;
  readonly host: string;
  readonly port?: number;
  readonly key: string;
  /** Maximum command length accepted for run_remote. */
  readonly maxCommandLength?: number;
}

interface InfraHosts {
  readonly hosts?: Record<string, HostEntry>;
}

const HOST_PATTERN = /^([a-zA-Z0-9_.\-]+|[a-zA-Z0-9_.\-:]+)$/;

function fail(tool: string, message: string): ToolResult {
  return { content: `${tool}: ${message}`, isError: true };
}

async function denied(name: string, reason: string, context: ToolContext): Promise<ToolResult> {
  await context.audit?.({ tool: name, decision: reason === "approval expired" ? "expired" : "denied", reason });
  return fail(name, reason);
}

/** Resolve and parse <home>/infra-hosts.json. Refuses the loop in agent home by configuration. */
async function loadHosts(home: string): Promise<Record<string, HostEntry>> {
  const file = path.join(home, "infra-hosts.json");
  let raw: string;
  try { raw = await readFile(file, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`infra-hosts.json not found in agent home (${home}); create it before using read_remote / run_remote`);
    }
    throw error;
  }
  let parsed: unknown;
  try { parsed = JSON.parse(raw) as unknown; }
  catch (error) {
    throw new Error(`infra-hosts.json: not valid JSON (${(error as Error).message}); see docs/OPERATIONS.md §5 for the schema. File: ${file}`);
  }
  if (parsed === null || typeof parsed !== "object") throw new Error("infra-hosts.json: must be an object");
  const typed = parsed as InfraHosts;
  const hosts = typed.hosts;
  if (hosts === undefined || typeof hosts !== "object" || hosts === null) {
    throw new Error("infra-hosts.json: 'hosts' must be an object");
  }
  for (const [name, entry] of Object.entries(hosts)) {
    if (!HOST_PATTERN.test(name)) throw new Error(`infra-hosts.json: host name '${name}' is not allowed`);
    if (entry === null || typeof entry !== "object") throw new Error(`infra-hosts.json: entry for '${name}' must be an object`);
    if (typeof entry.user !== "string" || entry.user.length === 0) throw new Error(`infra-hosts.json: '${name}'.user must be a non-empty string`);
    if (typeof entry.host !== "string" || entry.host.length === 0) throw new Error(`infra-hosts.json: '${name}'.host must be a non-empty string`);
    if (typeof entry.key !== "string" || entry.key.length === 0) throw new Error(`infra-hosts.json: '${name}'.key must be a non-empty string`);
    if (entry.port !== undefined && (typeof entry.port !== "number" || !Number.isSafeInteger(entry.port) || entry.port < 1 || entry.port > 65535)) {
      throw new Error(`infra-hosts.json: '${name}'.port must be an integer in [1, 65535]`);
    }
    if (entry.maxCommandLength !== undefined && (typeof entry.maxCommandLength !== "number" || entry.maxCommandLength < 1)) {
      throw new Error(`infra-hosts.json: '${name}'.maxCommandLength must be a positive integer`);
    }
  }
  return hosts as Record<string, HostEntry>;
}

/** Resolve a private key inside <home>/infra-keys/, refuse path traversal. */
async function resolveKeyPath(home: string, key: string): Promise<string> {
  const base = path.resolve(home, "infra-keys");
  const resolved = path.resolve(base, key);
  const rel = path.relative(base, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) throw new Error(`infra-hosts.json: key '${key}' escapes infra-keys/`);
  const info = await stat(resolved);
  if (!info.isFile()) throw new Error(`infra-hosts.json: key '${key}' is not a regular file`);
  return resolved;
}

async function findSsh(): Promise<string> {
  if (process.platform === "win32") {
    return "C:\\Windows\\System32\\OpenSSH\\ssh.exe";
  }
  return "/usr/bin/ssh";
}

/** Build the argv for a real ssh invocation. Pure, exported for tests.
 *
 * `entry.host` is the ssh target host, never the alias the operator types
 * (a D51 follow-up bug: an earlier version passed `${user}@${alias}` and ssh
 * tried to DNS-resolve the alias, which only the dry-run path tested caught).
 */
export function buildSshArgv(
  sshBin: string,
  entry: HostEntry,
  keyPath: string,
  remoteCommand: string,
  options: { knownHostsFile?: string } = {},
): string[] {
  const argv = [sshBin, `${entry.user}@${entry.host}`];
  argv.push("-i", keyPath);
  if (entry.port !== undefined) argv.push("-p", String(entry.port));
  argv.push("-o", "BatchMode=yes");
  if (options.knownHostsFile !== undefined) argv.push("-o", `UserKnownHostsFile=${options.knownHostsFile}`);
  argv.push("-o", "StrictHostKeyChecking=accept-new");
  argv.push("--", remoteCommand);
  return argv;
}

interface SshResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
}

async function runSsh(remote: string, args: readonly string[], signal?: AbortSignal): Promise<SshResult> {
  const ssh = await findSsh();
  const stdoutChunks: Buffer[] = []; let stdoutLen = 0; let stdoutTruncated = false;
  const stderrChunks: Buffer[] = []; let stderrLen = 0; let stderrTruncated = false;
  const child = spawn(ssh, [remote, ...args], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  const timer = setTimeout(() => { try { child.kill("SIGKILL"); } catch { /* already gone */ } }, SSH_TIMEOUT_MS);
  const abort = () => { try { child.kill("SIGKILL"); } catch { /* already gone */ } };
  signal?.addEventListener("abort", abort, { once: true });
  return await new Promise<SshResult>((resolve, reject) => {
    child.stdout.on("data", (chunk: Buffer) => {
      if (stdoutTruncated) return;
      if (stdoutLen + chunk.length > SSH_MAX_OUTPUT_BYTES) {
        stdoutChunks.push(chunk.subarray(0, SSH_MAX_OUTPUT_BYTES - stdoutLen));
        stdoutTruncated = true; return;
      }
      stdoutChunks.push(chunk); stdoutLen += chunk.length;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrTruncated) return;
      if (stderrLen + chunk.length > SSH_MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk.subarray(0, SSH_MAX_OUTPUT_BYTES - stderrLen));
        stderrTruncated = true; return;
      }
      stderrChunks.push(chunk); stderrLen += chunk.length;
    });
    child.once("error", (error) => { clearTimeout(timer); signal?.removeEventListener("abort", abort); reject(error); });
    child.once("exit", (code) => {
      signal?.removeEventListener("abort", abort);
        clearTimeout(timer);
        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        const suffix = (cond: boolean) => cond ? `\n[... output truncated at ${SSH_MAX_OUTPUT_BYTES} bytes]` : "";
        resolve({ stdout: stdout + suffix(stdoutTruncated), stderr: stderr + suffix(stderrTruncated), exitCode: code ?? -1 });
    });
  });
}

/** Read a file on the remote host over ssh. */
export function createReadRemoteTool(homeResolver: () => string): Tool {
  return {
    name: "read_remote",
    description:
      "Read a file on a remote host over ssh. `host` must be listed in <home>/infra-hosts.json. " +
      "`path` is an absolute path on that host. Read-only: it never modifies the remote filesystem.",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "Host alias configured in infra-hosts.json." },
        path: { type: "string", description: "Absolute path on the remote host." },
        length: { type: "integer", description: "Optional maximum number of bytes to read." },
      },
      required: ["host", "path"],
    },
    readOnly: true,
    async execute(args, context) {
      const host = args.host;
      const remotePath = args.path;
      const length = args.length;
      if (typeof host !== "string" || host.length === 0) return fail("read_remote", "'host' must be a non-empty string");
      if (typeof remotePath !== "string" || remotePath.length === 0) return fail("read_remote", "'path' must be a non-empty string");
      if (!path.isAbsolute(remotePath)) return fail("read_remote", "'path' must be absolute on the remote host");
      if (length !== undefined && (typeof length !== "number" || !Number.isSafeInteger(length) || length <= 0)) {
        return fail("read_remote", "'length' must be a positive integer");
      }
      const home = homeResolver();
      let hosts: Record<string, HostEntry>;
      let keyPath: string;
      try {
        hosts = await loadHosts(home);
        const entry = hosts[host];
        if (!entry) return fail("read_remote", `host '${host}' is not in infra-hosts.json`);
        keyPath = await resolveKeyPath(home, entry.key);
      } catch (error) {
        return fail("read_remote", (error as Error).message);
      }
      const limit = Math.min(length ?? SSH_MAX_OUTPUT_BYTES, SSH_MAX_OUTPUT_BYTES);
      const entry = hosts[host]!;
      const remote = `${entry.user}@${host}`;
      // `cat` is portable and exits non-zero if the path is missing or unreadable,
      // so the same exit-code check below catches both the ssh failure and a bad
      // remote path. A length-bounded read uses `head -c` and pipes through `cat`
      // so an over-large file does not pull the rest into memory on the agent.
      const remoteCommand = length === undefined
        ? `cat -- ${shellQuote(remotePath)}`
        : `head -c ${limit} -- ${shellQuote(remotePath)}; rc=$?; if [ $rc -eq 0 ]; then exit 0; else cat -- ${shellQuote(remotePath)} >/dev/null; exit $?; fi`;
      try {
        const argv = buildSshArgv(await findSsh(), entry, keyPath, remoteCommand, { knownHostsFile: "/agent-home/.ssh/known_hosts" });
        const sshTarget = argv[1]!;
        const result = await runSsh(sshTarget, argv.slice(2), context.signal);
        if (result.exitCode !== 0) return fail("read_remote", `ssh exit ${result.exitCode}\n${result.stderr || result.stdout}`);
        return { content: result.stdout };
      } catch (error) {
        return fail("read_remote", (error as Error).message);
      }
    },
  };
}

/** Run a command on a remote host over ssh. Defaults to dry-run, requires approval otherwise. */
export function createRunRemoteTool(homeResolver: () => string): Tool {
  return {
    name: "run_remote",
    description:
      "Run a command on a remote host over ssh. `host` must be listed in <home>/infra-hosts.json. " +
      "By default dry_run is true: the tool prints the exact command that would run, then exits without executing. " +
      "Set dry_run=false to execute; that requires approval under every tier that offers this tool. " +
      "Output is capped at 256 KiB per stream; longer output is truncated and noted.",
    parameters: {
      type: "object",
      properties: {
        host: { type: "string", description: "Host alias configured in infra-hosts.json." },
        command: { type: "string", description: "Command to run on the remote host." },
        dry_run: {
          type: "boolean",
          description: "Default true. When true, print the exact ssh invocation and exit without running.",
        },
      },
      required: ["host", "command"],
    },
    readOnly: false,
    async execute(args, context) {
      const host = args.host;
      const command = args.command;
      const dryRun = args.dry_run === undefined ? true : args.dry_run;
      if (typeof host !== "string" || host.length === 0) return fail("run_remote", "'host' must be a non-empty string");
      if (typeof command !== "string" || command.length === 0) return fail("run_remote", "'command' must be a non-empty string");
      if (typeof dryRun !== "boolean") return fail("run_remote", "'dry_run' must be a boolean");
      const home = homeResolver();
      let hosts: Record<string, HostEntry>;
      let keyPath: string;
      try {
        hosts = await loadHosts(home);
        const entry = hosts[host];
        if (!entry) return fail("run_remote", `host '${host}' is not in infra-hosts.json`);
        const cap = entry.maxCommandLength ?? 4096;
        if (command.length > cap) return fail("run_remote", `'command' is ${command.length} chars; limit is ${cap} for host '${host}'`);
        keyPath = await resolveKeyPath(home, entry.key);
      } catch (error) {
        return fail("run_remote", (error as Error).message);
      }
      const entry = hosts[host]!;
      const dryArgv = buildSshArgv(await findSsh(), entry, keyPath, command);
      if (dryRun) {
        return { content: `dry-run; would invoke:\n  ${dryArgv.map(shellQuote).join(" ")}\nSet dry_run=false to actually run.` };
      }
      const denial = await approveExact("run_remote", args, `Run on ${host}?\n${command}\n本次批准 2 分钟内有效。`, context);
      if (denial) return denied("run_remote", denial, context);
      try {
        const argv = buildSshArgv(await findSsh(), entry, keyPath, command, { knownHostsFile: "/agent-home/.ssh/known_hosts" });
        const sshTarget = argv[1]!;
        const result = await runSsh(sshTarget, argv.slice(2), context.signal);
        const body = `$ ssh ${sshTarget} exit ${result.exitCode}\n${result.stderr ? `[stderr]\n${result.stderr}\n` : ""}${result.stdout}`;
        if (result.exitCode !== 0) return { content: body, isError: true };
        return { content: body };
      } catch (error) {
        return fail("run_remote", (error as Error).message);
      }
    },
  };
}

/** Single-quote a shell argument so it is round-trip safe. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}