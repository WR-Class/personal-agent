/**
 * Tools the model may ask for.
 *
 * A tool receives a parsed JSON object, not schema-validated arguments.
 * Built-in read_file enforces path and sensitive-data policy; arbitrary in-process
 * tools must be trusted and can bypass cooperative context. This is not a sandbox.
 *
 * Every failure path returns `isError: true` rather than throwing, because a
 * tool failure is information for the model, not a crash for the loop.
 */

import { createHash } from "node:crypto";
import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import type { JsonSchema, ToolCall, ToolDefinition } from "./types.ts";
import type { ToolEnvironment } from "./tool-environment.ts";
import { isIssuedToolEnvironment } from "./tool-environment.ts";
import { assertReadablePath, canonicalPath, isWithin, protectedRoots } from "./security-config.ts";
import { checkReadable } from "./trusted-roots.ts";
import { actionBinding, DEFAULT_RULES, filePolicy } from "./file-policy.ts";
import { decide } from "./rule-table.ts";
import type { Rule } from "./rule-table.ts";
import type { FileGrant } from "./file-policy.ts";
import { readBoundedUtf8 } from "./bounded-read.ts";
import {
  findInspectionTool,
  inspectionToolNames,
  INSPECTION_MAX_LINES,
  runInspection,
} from "./inspection-tools.ts";
import { runShellCommand, shellFor } from "./shell-tool.ts";
import { FOREGROUND_GRACE_MS, findJob, killJob, listJobs, readJobOutput, startBackgroundJob } from "./background-jobs.ts";

export interface ToolResult {
  content: string;
  isError?: boolean;
}

export interface ToolContext {
  /** Absolute path; every filesystem tool resolves against it. */
  workspaceRoot: string;
  /**
   * The rebuilt environment a child process must be given.
   *
   * `AgentRuntime` always supplies this. It is optional only so that a pure
   * in-process tool can be unit-tested without a runtime; a tool that actually
   * needs an environment must read it through {@link requireToolEnvironment},
   * never through `process.env`.
   */
  toolEnvironment?: ToolEnvironment;
  /** Trusted runtime supplies its state/log roots; never model-controlled. */
  protectedRoots?: readonly string[];
  /**
   * Extra roots that may be *read*, never written (D35).
   *
   * Kept separate from `workspaceRoot` on purpose. Reads and writes share one
   * gate, so widening the workspace would widen both; a caller that wants to
   * review code elsewhere does not thereby want to edit it. Only the read tools
   * consult this, and it is supplied by the trust file in the agent home rather
   * than by anything inside the repository being read.
   */
  readableRoots?: readonly string[];
  /**
   * Denied even inside an added readable root (D35).
   *
   * Distinct from `protectedRoots`, which holds whole host trees such as
   * `%LOCALAPPDATA%`. Re-applying those inside a granted root would refuse
   * nearly every directory a user could name, so the runtime passes only its own
   * state and log roots here — the things that stay private no matter which
   * tree the operator opened.
   */
  protectedStateRoots?: readonly string[];
  signal?: AbortSignal;
  /** Asked before the one write tool replaces an existing file. */
  approve?(prompt: string): Promise<boolean>;
  /**
   * Set by the registry when the rule table decided `allow` for this call.
   *
   * Without this the tier could say "do not ask" and the tool would ask anyway,
   * because the write tools call `approveExact` unconditionally and nothing ever
   * told them the table had already spoken. Measured: under `full-access`, which
   * allows everything, `run_command` ran while every file tool failed with "no
   * approval channel is configured" — the tier's whole purpose defeated for half
   * the tools it names.
   *
   * Only `allow` sets it. An `approve` decision leaves it unset, so the tool asks
   * as before, and a `deny` is refused by the registry before this matters.
   */
  preApproved?: boolean;
  /** Exact grants already approved by a parent operation. */
  grants?: readonly FileGrant[];
  /** Records a denial without changing the conversation. */
  audit?(event: { tool: string; decision: "denied" | "expired"; reason: string; rule?: string | null }): Promise<void>;
  /** The rule table this session runs under. Defaults to the built-in rules. */
  rules?: readonly Rule[];
}

/** Raised when a tool needs an environment that the caller did not rebuild. */
export class MissingToolEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MissingToolEnvironmentError";
  }
}

/**
 * Read the rebuilt environment, or fail loudly.
 *
 * This is deliberately not a fallback to `process.env`. A silent fallback would
 * hand a child process the operator's `HOME`, which is the failure mode the
 * whole module exists to prevent — so the absence of an environment is an
 * error, not a default.
 */
export function requireToolEnvironment(context: ToolContext): ToolEnvironment {
  const environment = context.toolEnvironment;
  if (environment === undefined || !isIssuedToolEnvironment(environment)) {
    throw new MissingToolEnvironmentError(
      "tool executed without a rebuilt environment: refusing to fall back to the parent " +
        "process environment, whose HOME is the operator's",
    );
  }
  return environment;
}

export interface Tool {
  readonly name: string;
  readonly description: string;
  readonly parameters: JsonSchema;
  /** Host-trusted declaration. Non-readOnly tools are currently denied by the registry. */
  readonly readOnly: boolean;
  execute(args: Record<string, unknown>, context: ToolContext): Promise<ToolResult>;
}

const READ_FILE_MAX_BYTES = 256 * 1024;
const WRITE_FILE_MAX_BYTES = 256 * 1024;
const APPROVAL_TTL_MS = 2 * 60 * 1000;
const SUPPORTED_SCHEMA_KEYS = new Set([
  "type",
  "properties",
  "required",
  "items",
  "additionalProperties",
  "enum",
  "const",
  "description",
]);
const SCHEMA_TYPES = new Set(["array", "boolean", "integer", "null", "number", "object", "string"]);

function fail(tool: string, message: string): ToolResult {
  return { content: `${tool}: ${message}`, isError: true };
}

async function denied(name: string, reason: string, context: ToolContext): Promise<ToolResult> {
  await context.audit?.({ tool: name, decision: reason === "approval expired" ? "expired" : "denied", reason });
  return fail(name, reason);
}

/** Ask once unless this exact call already has an unexpired grant. */
async function approveExact(name: string, args: unknown, prompt: string, context: ToolContext): Promise<string | undefined> {
  // The tier already allowed this call, so asking would contradict the posture
  // the operator chose. This is what makes `full-access` mean "do not ask"
  // rather than "do not ask, except for the file tools".
  if (context.preApproved === true) return undefined;
  const now = Date.now();
  // Bound to the action's content hash, not to the spelling of its arguments, so
  // an identical action written with keys in another order is still a cache hit
  // (D29) while any changed value is still a miss.
  const expected = actionBinding(name, args);
  const granted = context.grants?.some((grant) => {
    if (now > grant.expiresAt) return false;
    // A grant whose arguments cannot be read is ignored rather than fatal: it
    // grants nothing, which is the safe reading, and it must not take the whole
    // tool call down with it.
    try {
      return actionBinding(grant.tool, JSON.parse(grant.argumentsJson)) === expected;
    } catch {
      return false;
    }
  }) === true;
  if (granted) return undefined;
  if (!context.approve) return "no approval channel is configured";
  const approved = await context.approve(prompt);
  if (Date.now() - now > APPROVAL_TTL_MS) return "approval expired";
  if (!approved) return "operator declined";
  return undefined;
}

/**
 * Resolve a *read* target, honouring the extra readable roots (D35).
 *
 * This is the only place that consults `readableRoots`, and it is deliberately
 * not used by the write tools: they call {@link assertReadablePath} directly and
 * so keep the workspace as their sole root. Two separate functions rather than a
 * flag on one, because a boolean at a call site is exactly the kind of thing
 * that gets flipped during a later refactor without anyone noticing that a read
 * widening became a write widening.
 *
 * The workspace case is delegated back to `assertReadablePath` so that the
 * existing deny list, sensitive-name check and canonicalization behave
 * identically inside the workspace and did not need to be reimplemented here.
 */
function assertReadablePathOutcome(target: string, context: ToolContext): string {
  const workspace = context.workspaceRoot;
  const extra = context.readableRoots ?? [];
  if (extra.length === 0) return assertReadablePath(target, workspace, context.protectedRoots);
  const lexical = path.resolve(target);
  const actual = canonicalPath(lexical);
  if (isWithin(canonicalPath(workspace), actual)) return assertReadablePath(lexical, workspace, context.protectedRoots);
  const scope = checkReadable(actual, canonicalPath(workspace), extra);
  if (scope !== undefined) throw new Error(scope);
  // Reached only through an added root, and `checkReadable` has already applied
  // the sensitive-name list there. The broad entries of `protectedRoots()` are
  // deliberately NOT re-applied: they are whole trees such as `%LOCALAPPDATA%`,
  // so re-applying them would refuse essentially every directory under a user
  // profile and make the added root unusable. The operator naming a root *is*
  // the decision that its tree may be read; what survives is the deny list the
  // runtime controls itself (its state and log roots), which the caller passes
  // in and which is never derived from the tree being read.
  for (const denied of context.protectedStateRoots ?? []) {
    if (isWithin(canonicalPath(denied), actual) || isWithin(canonicalPath(denied), lexical)) {
      throw new Error("sensitive path is denied");
    }
  }
  return actual;
}

/** Re-check immediately before a write. A replaced path must not receive it. */
function sameFile(before: string, workspace: string, protectedRoots: readonly string[] | undefined): string | undefined {
  try {
    const again = assertReadablePath(before, workspace, protectedRoots);
    return again === before ? undefined : "path changed before write";
  } catch (error) {
    return (error as Error).message;
  }
}

/**
 * A content hash of what the operator was actually shown (D30).
 *
 * Approving a write approves *that* content. The window between the prompt and
 * the write is not instant — the operator may take minutes — so the file can
 * move underneath the decision. Binding to the content read for the prompt and
 * re-reading immediately before the write is what turns "the operator approved
 * this" into "the operator approved this, and it is still what is on disk".
 *
 * Without it the stale read is written back verbatim: for `patch_file` the new
 * content is spliced into the old text, so a concurrent edit is not merely
 * overwritten, it is silently reverted.
 */
export function contentStamp(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

/** Re-read and compare. Returns the refusal reason, or undefined to proceed. */
async function unchangedSinceApproval(resolved: string, stamp: string, tool: string): Promise<string | undefined> {
  let current: string;
  try {
    current = await readFile(resolved, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // Gone or unreadable is drift too: the approved content is no longer there.
    return `${tool}: file changed after approval (${code ?? "unreadable"}); re-read it and try again`;
  }
  if (contentStamp(current) !== stamp) {
    return `${tool}: file changed after approval; re-read it and try again`;
  }
  return undefined;
}

function schemaError(pathName: string, message: string): Error {
  return new Error(`unsupported tool schema at ${pathName}: ${message}`);
}

function inspectSchema(schema: unknown, pathName = "$", root = false): Record<string, unknown> {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema)) {
    throw schemaError(pathName, "schema must be an object");
  }
  const value = schema as Record<string, unknown>;
  for (const key of Object.keys(value)) {
    if (!SUPPORTED_SCHEMA_KEYS.has(key)) throw schemaError(`${pathName}.${key}`, "keyword is not supported");
  }
  if (typeof value.type !== "string" || !SCHEMA_TYPES.has(value.type)) {
    throw schemaError(`${pathName}.type`, "must be one supported type");
  }
  if (root && value.type !== "object") throw schemaError(`${pathName}.type`, "root type must be object");
  if (value.description !== undefined && typeof value.description !== "string") {
    throw schemaError(`${pathName}.description`, "must be a string");
  }
  if (value.required !== undefined &&
      (!Array.isArray(value.required) || value.required.some((item) => typeof item !== "string"))) {
    throw schemaError(`${pathName}.required`, "must be an array of strings");
  }
  if (value.properties !== undefined) {
    if (typeof value.properties !== "object" || value.properties === null || Array.isArray(value.properties)) {
      throw schemaError(`${pathName}.properties`, "must be an object");
    }
    for (const [key, child] of Object.entries(value.properties as Record<string, unknown>)) {
      inspectSchema(child, `${pathName}.properties.${key}`);
    }
  }
  if (value.items !== undefined) inspectSchema(value.items, `${pathName}.items`);
  if (value.additionalProperties !== undefined && typeof value.additionalProperties !== "boolean") {
    throw schemaError(`${pathName}.additionalProperties`, "must be a boolean");
  }
  if (value.enum !== undefined && (!Array.isArray(value.enum) || value.enum.length === 0)) {
    throw schemaError(`${pathName}.enum`, "must be a non-empty array");
  }
  if (value.const !== undefined && (typeof value.const === "object" || typeof value.const === "function")) {
    throw schemaError(`${pathName}.const`, "must be a JSON scalar");
  }
  return value;
}

function matchesSchema(schema: Record<string, unknown>, value: unknown, pathName = "$"): string | undefined {
  const type = schema.type;
  const typeMatches = type === "null" ? value === null
    : type === "array" ? Array.isArray(value)
    : type === "object" ? typeof value === "object" && value !== null && !Array.isArray(value)
    : type === "integer" ? typeof value === "number" && Number.isSafeInteger(value)
    : type === "number" ? typeof value === "number" && Number.isFinite(value)
    : type === "boolean" ? typeof value === "boolean"
    : typeof value === "string";
  if (!typeMatches) return `${pathName} must be ${String(type)}`;
  if (Array.isArray(schema.enum) && !schema.enum.some((item) => Object.is(item, value))) {
    return `${pathName} must match one of the declared enum values`;
  }
  if (schema.const !== undefined && !Object.is(schema.const, value)) return `${pathName} must match the declared const`;
  if (type === "object") {
    const objectValue = value as Record<string, unknown>;
    const properties = (schema.properties ?? {}) as Record<string, unknown>;
    for (const required of (schema.required as string[] | undefined) ?? []) {
      if (!(required in objectValue)) {
        const requiredSchema = properties[required] as Record<string, unknown> | undefined;
        return requiredSchema?.type === "string"
          ? `${pathName}.${required} must be a non-empty string`
          : `${pathName}.${required} is required`;
      }
    }
    if (schema.additionalProperties === false) {
      for (const key of Object.keys(objectValue)) {
        if (!(key in properties)) return `${pathName}.${key} is not allowed`;
      }
    }
    for (const [key, child] of Object.entries(properties)) {
      if (key in objectValue) {
        const problem = matchesSchema(child as Record<string, unknown>, objectValue[key], `${pathName}.${key}`);
        if (problem) return problem;
      }
    }
  } else if (type === "array" && schema.items !== undefined) {
    for (let index = 0; index < (value as unknown[]).length; index += 1) {
      const problem = matchesSchema(schema.items as Record<string, unknown>, (value as unknown[])[index], `${pathName}[${index}]`);
      if (problem) return problem;
    }
  }
  return undefined;
}

function validateToolArguments(schema: unknown, args: unknown): string | undefined {
  const inspected = inspectSchema(schema, "$", true);
  return matchesSchema(inspected, args);
}

/** Chunk a file handle so the shared byte ceiling applies to it too. */
async function* fileChunks(handle: FileHandle): AsyncIterable<Uint8Array> {
  for (;;) {
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
    if (bytesRead === 0) return;
    yield buffer.subarray(0, bytesRead);
  }
}

/**
 * Read one file as bytes, changing nothing about the file itself (D38).
 *
 * Returns bytes rather than text because the previous version decoded in here,
 * and decoding is not a display decision — it is the point at which the
 * information is destroyed. A byte that is not valid UTF-8 became U+FFFD, and
 * the original byte could not be recovered: measured, `89 50 4e 47 ff fe fd 00`
 * came back as `efbfbd 50 4e 47 efbfbd efbfbd efbfbd 00`, which is not the same
 * bytes and is *longer* than the input. Handing that to a model reviewing a
 * binary is worse than refusing: it looks like text and carries no signal that
 * it is corrupt.
 */
async function readBoundedBytes(filePath: string, maxBytes: number, start = 0, length?: number): Promise<Buffer> {
  const handle = await open(filePath, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    const cap = Math.min(maxBytes, length ?? maxBytes);
    // A positional read, so seeking to the header of a large file never pulls
    // the whole file into memory first.
    const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, cap));
    let position = start;
    while (total < cap) {
      const want = Math.min(buffer.length, cap - total);
      const { bytesRead } = await handle.read(buffer, 0, want, position);
      if (bytesRead === 0) break;
      chunks.push(Buffer.from(buffer.subarray(0, bytesRead)));
      total += bytesRead;
      position += bytesRead;
    }
    return Buffer.concat(chunks);
  } finally {
    await handle.close();
  }
}

/** Hex preview width, in bytes per row. */
const HEX_ROW_BYTES = 16;

/**
 * Render bytes as an offset/hex/ASCII dump.
 *
 * Hex is unambiguous and lossless by construction, which is the whole
 * requirement: the model must be able to read the real bytes of a header,
 * string table or disassembly. The ASCII gutter is convenience only and prints
 * a dot for anything outside printable ASCII, so it can never be mistaken for
 * the content itself.
 */
function hexDump(bytes: Buffer, base = 0): string {
  const lines: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += HEX_ROW_BYTES) {
    const row = bytes.subarray(offset, offset + HEX_ROW_BYTES);
    const hex = [...row].map((b) => b.toString(16).padStart(2, "0")).join(" ");
    const ascii = [...row].map((b) => (b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : ".")).join("");
    // Offsets are file-absolute, so a partial read lines up with the real file
    // and the model can ask for a specific range next.
    lines.push(`${(base + offset).toString(16).padStart(8, "0")}  ${hex.padEnd(HEX_ROW_BYTES * 3 - 1)}  ${ascii}`);
  }
  return lines.join("\n");
}

/**
 * Whether these bytes are text this tool can hand over unchanged.
 *
 * Two conditions, and both are needed. The bytes must survive a decode/encode
 * round trip, which rejects a lone 0xFF or a truncated multi-byte sequence. That
 * alone is not enough, and the failure is instructive: the 64-byte DOS header of
 * a real executable is *valid* UTF-8 — every byte is under 0x80 — so a
 * round-trip test alone hands back `MZx` followed by 57 NUL bytes as if it were
 * a text file. A NUL byte is what actually separates the two cases here, because
 * no text file this tool should render as text contains one. UTF-16 text is
 * caught by the round trip instead, since it is not valid UTF-8 at all.
 */
function isRoundTripUtf8(bytes: Buffer): boolean {
  if (bytes.includes(0x00)) return false;
  return Buffer.from(bytes.toString("utf8"), "utf8").equals(bytes);
}

/**
 * Read one file inside the workspace.
 *
 * Path policy is delegated wholesale to {@link assertReadablePath}, the single
 * containment/deny implementation this project has. An earlier version ran its
 * own `resolveInside` here — a second algorithm for the same question, with its
 * own failure strategy — and then re-checked the result, so containment was
 * decided three times per read by two implementations that could drift apart.
 * Consolidating is not a claim that a re-check was useless: `assertReadablePath`
 * checks the requested spelling *and* the canonical path, including the
 * nearest-existing-ancestor case, which is what the deleted helper approximated
 * with an ENOENT fallback.
 *
 * This is a cooperative check against path confusion, not a race-free
 * guarantee: a target may still be swapped between this call and `open`.
 */

/**
 * Run one of the product's audited read-only inspection tools (D41).
 *
 * The point of this tool is what it cannot express. `tool` is an enum drawn from
 * {@link INSPECTION_TOOLS}, a constant in this repository, and `path` is a path
 * — there is no parameter anywhere that accepts a command string. So the model
 * chooses *which* audited tool to apply, not what to execute, and shell
 * metacharacters are not filtered out so much as impossible to write down.
 *
 * If the model could name an arbitrary executable, this would be a shell with
 * extra steps, which is the option that was explicitly rejected in favour of
 * this one.
 *
 * Read access is checked by exactly the same function `read_file` uses, so the
 * workspace boundary and the operator-granted readable roots (D35) apply here
 * identically and there is still only one implementation of that question.
 */
export function createInspectFileTool(): Tool {
  return {
    name: "inspect_file",
    description:
      "Inspect a file with a fixed, read-only tool from a built-in list. Use this to examine " +
      "binaries and other non-text files. `tool` is one of: " +
      `${inspectionToolNames().join(", ")}. ` +
      "Files outside the workspace need to have been granted read access first. " +
      "This runs no shell: the tool name and the path are passed as separate arguments.",
    parameters: {
      type: "object",
      properties: {
        tool: {
          type: "string",
          enum: inspectionToolNames(),
          description: "Which built-in read-only tool to use.",
        },
        path: {
          type: "string",
          description: "File to inspect. Absolute, or relative to the workspace root.",
        },
        lines: {
          type: "integer",
          description: `Optional hint for how much to read, at most ${INSPECTION_MAX_LINES}.`,
        },
      },
      required: ["tool", "path"],
    },
    readOnly: true,
    async execute(args, context) {
      const name = args.tool;
      const target = args.path;
      if (typeof name !== "string" || name.length === 0) return fail("inspect_file", "'tool' must be a non-empty string");
      if (typeof target !== "string" || target.length === 0) return fail("inspect_file", "'path' must be a non-empty string");
      // The enum is enforced here too, not only advertised in the schema: a
      // schema is a description of what we accept, not a gate.
      const tool = findInspectionTool(name);
      if (!tool) {
        return fail(
          "inspect_file",
          `unknown tool '${name}'; available: ${inspectionToolNames().join(", ")}`,
        );
      }
      const rawLines = args.lines;
      if (rawLines !== undefined && (typeof rawLines !== "number" || !Number.isSafeInteger(rawLines) || rawLines <= 0)) {
        return fail("inspect_file", "'lines' must be a positive integer");
      }
      const lines = typeof rawLines === "number" ? Math.min(rawLines, INSPECTION_MAX_LINES) : undefined;

      let resolved: string;
      try {
        resolved = assertReadablePathOutcome(path.resolve(context.workspaceRoot, target), context);
      } catch (error) {
        return fail("inspect_file", (error as Error).message);
      }
      const result = await runInspection(
        tool,
        resolved,
        lines === undefined ? {} : { lines },
        context.signal,
      );
      return result.isError ? fail("inspect_file", result.content) : { content: result.content };
    },
  };
}

/**
 * Run a shell command (D46).
 *
 * This is the capability the agent was missing: without it nothing can be
 * built, tested, inspected or repaired, because every one of those means
 * running a program. It is deliberately a real shell rather than a fixed list of
 * audited commands, because what a command should be depends on what is being
 * done at the time and cannot be enumerated in advance — the same reason the
 * operator's earlier instruction gave for the tool axis being undecidable
 * a priori while the directory axis is fixed.
 *
 * What this does *not* do is decide whether the command may run. That is the
 * permission tier's job, and the table's default is deny, so a tier that does
 * not name this tool cannot reach it even if it is present.
 */
export function createRunCommandTool(): Tool {
  return {
    name: "run_command",
    description:
      "Run a shell command and return its output. Use this to build, test, search, and inspect: " +
      "anything you would otherwise type into a terminal. The command runs through the platform " +
      "shell (cmd.exe on Windows, /bin/sh elsewhere) with the workspace as its working directory, " +
      "so pipes, redirection and `&&` work as usual. A non-zero exit code is reported together " +
      "with the output rather than treated as a failure of this tool, so read the output to find " +
      "out what went wrong and correct the command. " +
      `Set run_in_background to true for work that will take longer than ${FOREGROUND_GRACE_MS / 1000} ` +
      "seconds, such as installing dependencies or running a full test suite; you get a job id " +
      "immediately, and read it later with job_output. Output is capped, and a command that runs " +
      "too long in the foreground is moved to the background rather than killed.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: "The command to execute, exactly as you would type it in a terminal.",
        },
        run_in_background: {
          type: "boolean",
          description:
            "Start the command as a background job and return at once, instead of waiting for it. " +
            "Read its output later with job_output.",
        },
      },
      required: ["command"],
    },
    readOnly: false,
    async execute(args, context) {
      const command = args.command;
      if (typeof command !== "string" || command.length === 0) {
        return fail("run_command", "'command' must be a non-empty string");
      }
      const background = args.run_in_background;
      if (background !== undefined && typeof background !== "boolean") {
        return fail("run_command", "'run_in_background' must be a boolean");
      }
      // The tier decides whether this runs without asking. Measured consequence
      // of leaving this out: under `workspace-write`, whose rule for this tool is
      // `approve`, the model ran `echo hi > test.txt` and the file appeared — the
      // tool ignored the tier entirely, so the default posture did not gate the
      // one capability most in need of gating.
      const denial = await approveExact("run_command", args, `Run this command?\n${command}\n本次批准 2 分钟内有效。`, context);
      if (denial) return denied("run_command", denial, context);
      // The environment is required rather than optional, so a caller that has
      // not built one fails loudly here instead of silently running with the
      // parent process's HOME, which is the operator's.
      let environment;
      try {
        environment = requireToolEnvironment(context);
      } catch (error) {
        return fail("run_command", (error as Error).message);
      }
      if (background === true) {
        const job = await startBackgroundJob(command, environment, shellFor());
        // The id is the whole point of the reply: it is what the model uses to
        // read the output later, and it cannot be derived from the command.
        return { content: `started background job ${job.id}\n${command}\n\nRead its output with job_output.` };
      }
      const result = await runShellCommand(command, environment, context.signal);
      return result.isError ? fail("run_command", result.content) : { content: result.content };
    },
  };
}

/**
 * Read a background job's output (D47).
 *
 * Separate from `run_command` because the two answer different questions: one
 * starts work, the other reports on work that is already running. Folding the
 * second into the first would mean a model that lost the job id had no way to
 * ask what was running, and re-running a command to see its output is exactly
 * the mistake that makes a long job expensive.
 */
export function createJobOutputTool(): Tool {
  return {
    name: "job_output",
    description:
      "Read the output of a background job started with run_command run_in_background. " +
      "Omit job_id to list every job this session has started, with its state and exit code. " +
      "Only the tail of a long output is returned, and the amount omitted is stated.",
    parameters: {
      type: "object",
      properties: {
        job_id: {
          type: "string",
          description: "The job id from run_command. Omit to list all jobs.",
        },
      },
      required: [],
    },
    readOnly: true,
    async execute(args) {
      const id = args.job_id;
      if (id !== undefined && typeof id !== "string") {
        return fail("job_output", "'job_id' must be a string");
      }
      if (id === undefined || id === "") {
        const all = listJobs();
        if (all.length === 0) return { content: "no background jobs have been started in this session" };
        const lines = all.map((job) => {
          const state = job.finishedAt === null ? "running" : `exit ${job.exitCode}`;
          return `${job.id}  [${state}]  ${job.command}`;
        });
        return { content: lines.join("\n") };
      }
      return { content: await readJobOutput(id) };
    },
  };
}

/** Stop a background job (D47). */
export function createJobKillTool(): Tool {
  return {
    name: "job_kill",
    description:
      "Stop a background job started with run_command run_in_background. The process is killed, " +
      "along with anything the command itself started. Reports whether the job was found.",
    parameters: {
      type: "object",
      properties: {
        job_id: { type: "string", description: "The job id from run_command." },
      },
      required: ["job_id"],
    },
    readOnly: false,
    async execute(args, context) {
      const id = args.job_id;
      if (typeof id !== "string" || id === "") {
        return fail("job_kill", "'job_id' must be a non-empty string");
      }
      // Stopping work needs the same permission as starting it: a tier that may
      // not run a command should not be able to reach into a running one either,
      // and the rule table is consulted for this tool under the same rules.
      const denial = await approveExact("job_kill", args, `Stop background job ${id}?`, context);
      if (denial) return denied("job_kill", denial, context);
      const job = findJob(id);
      if (!job) return fail("job_kill", `no such job: ${id}`);
      if (job.finishedAt !== null) return { content: `${id} had already finished with exit code ${job.exitCode}` };
      killJob(id);
      // "Asked to stop" rather than "stopped": the kill is delivered immediately
      // but the process may take a moment to exit, and claiming it is gone would
      // be a claim this call cannot observe.
      return { content: `asked background job ${id} to stop; its output remains readable with job_output` };
    },
  };
}

export function createReadFileTool(): Tool {
  return {
    name: "read_file",
    // The description has to match what this actually does, and it did not.
    // It says text, but since binary reading was added it will also return a
    // hex dump for a binary or a NUL-containing file. Measured consequence: in
    // a live run asking about a real executable, the model chose `read_file`
    // over `inspect_file` and got the right answer from the hex dump, which was
    // a rational choice given a description that said text and a tool with
    // fewer parameters. Naming the binary case here, and saying what to prefer
    // instead, is the fix.
    description:
      "Read a file inside the workspace. `path` is relative to the workspace root (absolute paths inside it also work). " +
      "Text comes back as text; a binary file comes back as a hex dump, which is not a substitute for a real tool — " +
      "prefer `inspect_file` for binaries, executables and archives.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to read, relative to the workspace root." },
        offset: {
          type: "integer",
          description:
            "Optional byte offset to start at. Use with 'length' to read part of a large file, " +
            "such as the header of a binary.",
        },
        length: { type: "integer", description: "Optional number of bytes to read. Defaults to the whole file." },
      },
      required: ["path"]
    },
    readOnly: true,
    async execute(args, context) {
      const target = args.path;
      if (typeof target !== "string" || target.length === 0) {
        return fail("read_file", "'path' must be a non-empty string");
      }
      let resolved: string;
      try {
        resolved = assertReadablePathOutcome(path.resolve(context.workspaceRoot, target), context);
      } catch (error) {
        return fail("read_file", (error as Error).message);
      }
      let info;
      try {
        info = await stat(resolved);
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return fail("read_file", `no such file: ${target}`);
        if (code === "EISDIR") info = undefined;
        return fail("read_file", `cannot stat ${target}: ${code ?? String(error)}`);
      }
      if (!info.isFile()) return fail("read_file", `not a regular file: ${target}`);
      if (info.nlink > 1) return fail("read_file", "hard-linked files are denied");
      const offset = args.offset;
      const length = args.length;
      for (const [name, value] of [["offset", offset], ["length", length]] as const) {
        if (value !== undefined && (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0)) {
          return fail("read_file", `'${name}' must be a non-negative integer`);
        }
      }
      const start = typeof offset === "number" ? offset : 0;
      // A range read is the answer to large binaries rather than a bigger
      // ceiling: a PE header sits in the first few hundred bytes of a 92 MB
      // executable, and hex costs ~4.5 characters per byte, so a whole-file
      // dump of even the current limit already overflows the context window.
      const want = typeof length === "number" ? length : READ_FILE_MAX_BYTES;
      const span = Math.min(want, READ_FILE_MAX_BYTES);
      if (span === 0) return fail("read_file", "'length' must be greater than zero");
      if (start >= info.size) return fail("read_file", `offset ${start} is past the end of ${target} (${info.size} bytes)`);
      if (typeof length !== "number" && start === 0 && info.size > READ_FILE_MAX_BYTES) {
        return fail(
          "read_file",
          `${target} is ${info.size} bytes, over the ${READ_FILE_MAX_BYTES}-byte limit; ` +
          `pass 'offset' and 'length' to read part of it`,
        );
      }
      try {
        const bytes = await readBoundedBytes(resolved, READ_FILE_MAX_BYTES, start, span);
        if (isRoundTripUtf8(bytes)) return { content: bytes.toString("utf8") };
        // Say so explicitly. A model that is told this is a hex dump knows to
        // read offsets and bytes; one handed silent replacement characters has
        // no way to tell the content was damaged.
        const partial = start !== 0 || start + bytes.length < info.size;
        return {
          content:
            `[binary file: ${info.size} bytes total` +
            (partial ? `; showing bytes ${start}-${start + bytes.length - 1}` : "") +
            `; hex, not text]\n` +
            `offset    hex${" ".repeat(HEX_ROW_BYTES * 3 - 4)}ascii\n` +
            hexDump(bytes, start),
        };
      } catch (error) {
        return fail("read_file", `cannot read ${target}: ${(error as Error).message}`);
      }
    }
  };
}

function lineDiff(before: string, after: string): string {
  const oldLines = before.split(/\r?\n/);
  const nextLines = after.split(/\r?\n/);
  const lines: string[] = [];
  const limit = Math.max(oldLines.length, nextLines.length);
  for (let index = 0; index < limit; index += 1) {
    if (oldLines[index] === nextLines[index]) continue;
    if (index < oldLines.length) lines.push(`- ${oldLines[index]}`);
    if (index < nextLines.length) lines.push(`+ ${nextLines[index]}`);
  }
  const shown = lines.slice(0, 40);
  return lines.length > 40 ? `${shown.join("\n")}\n…其余 ${lines.length - 40} 行未显示` : shown.join("\n");
}

/**
 * Replace one existing UTF-8 text file inside the workspace.
 *
 * M2 first slice: no create, delete, rename, or batch edit. The operator must
 * approve this exact path and content. The replacement is one temp file plus
 * rename; a failed write leaves the original in place.
 */
export function createEditFileTool(): Tool {
  return {
    name: "edit_file",
    description: "Replace the full UTF-8 content of one existing workspace file. Creates nothing and deletes nothing.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "Existing file, relative to the workspace root." },
        content: { type: "string", description: "Complete replacement content." },
      },
      required: ["path", "content"],
    },
    readOnly: false,
    async execute(args, context) {
      const target = args.path;
      const content = args.content;
      if (typeof target !== "string" || target.length === 0) return fail("edit_file", "'path' must be a non-empty string");
      if (typeof content !== "string") return fail("edit_file", "'content' must be a string");
      if (Buffer.byteLength(content) > WRITE_FILE_MAX_BYTES) return fail("edit_file", `content exceeds ${WRITE_FILE_MAX_BYTES} bytes`);
      let resolved: string;
      try {
        resolved = assertReadablePath(path.resolve(context.workspaceRoot, target), context.workspaceRoot, context.protectedRoots);
      } catch (error) {
        return fail("edit_file", (error as Error).message);
      }
      let info;
      try { info = await stat(resolved); }
      catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "ENOENT") return fail("edit_file", `no such file: ${target}`);
        return fail("edit_file", `cannot stat ${target}: ${code ?? String(error)}`);
      }
      if (!info.isFile()) return fail("edit_file", `not a regular file: ${target}`);
      if (info.nlink > 1) return fail("edit_file", "hard-linked files are denied");
      if (info.size > WRITE_FILE_MAX_BYTES) return fail("edit_file", `${target} is ${info.size} bytes, over the ${WRITE_FILE_MAX_BYTES}-byte limit`);
      const current = await readFile(resolved, "utf8");
      const diff = lineDiff(current, content);
      const denial = await approveExact("edit_file", args, `Replace ${target} (${info.size} bytes) with ${Buffer.byteLength(content)} bytes?\n${diff || "内容没有变化"}\n本次批准 2 分钟内有效。`, context);
      if (denial) {
        await context.audit?.({ tool: "edit_file", decision: denial === "approval expired" ? "expired" : "denied", reason: denial });
        return fail("edit_file", denial);
      }
      const changed = sameFile(resolved, context.workspaceRoot, context.protectedRoots);
      if (changed) return fail("edit_file", changed);
      const drifted = await unchangedSinceApproval(resolved, contentStamp(current), "edit_file");
      if (drifted) return fail("edit_file", drifted);
      const temporary = `${resolved}.${process.pid}.tmp`;
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
      await rename(temporary, resolved);
      return { content: `replaced ${target}` };
    },
  };
}

/** Replace one exact text occurrence. Zero or multiple matches are refused. */
export function createPatchFileTool(): Tool {
  return {
    name: "patch_file",
    description: "Replace one exact text snippet in an existing file. The snippet must occur once.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string", description: "Exact text to find. It must occur once." },
        newText: { type: "string", description: "Replacement text." },
      },
      required: ["path", "oldText", "newText"],
    },
    readOnly: false,
    async execute(args, context) {
      const target = args.path;
      const oldText = args.oldText;
      const newText = args.newText;
      if (typeof target !== "string" || !target) return fail("patch_file", "'path' must name a file");
      if (typeof oldText !== "string" || oldText.length === 0) return fail("patch_file", "'oldText' must not be empty");
      if (typeof newText !== "string") return fail("patch_file", "'newText' must be a string");
      let resolved: string;
      try { resolved = assertReadablePath(path.resolve(context.workspaceRoot, target), context.workspaceRoot, context.protectedRoots); }
      catch (error) { return fail("patch_file", (error as Error).message); }
      let info;
      try { info = await stat(resolved); }
      catch { return fail("patch_file", `no such file: ${target}`); }
      if (!info.isFile() || info.nlink > 1 || info.size > WRITE_FILE_MAX_BYTES) return fail("patch_file", "file is not one editable regular file");
      const current = await readFile(resolved, "utf8");
      const first = current.indexOf(oldText);
      if (first < 0 || current.indexOf(oldText, first + oldText.length) >= 0) return fail("patch_file", "oldText must occur exactly once");
      const content = current.slice(0, first) + newText + current.slice(first + oldText.length);
      if (Buffer.byteLength(content) > WRITE_FILE_MAX_BYTES) return fail("patch_file", "replacement exceeds the byte limit");
      const denial = await approveExact("patch_file", args, `Patch ${target}?\n${lineDiff(current, content)}\n本次批准 2 分钟内有效。`, context);
      if (denial) return denied("patch_file", denial, context);
      const changed = sameFile(resolved, context.workspaceRoot, context.protectedRoots);
      if (changed) return fail("patch_file", changed);
      // The new content was spliced into `current`; if the file moved, writing it
      // would revert whatever the other writer added rather than merely conflict.
      const drifted = await unchangedSinceApproval(resolved, contentStamp(current), "patch_file");
      if (drifted) return fail("patch_file", drifted);
      const temporary = `${resolved}.${process.pid}.patch.tmp`;
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
      await rename(temporary, resolved);
      return { content: `patched ${target}` };
    },
  };
}

/** Create one new UTF-8 text file. An existing path is refused, never overwritten. */
export function createCreateFileTool(): Tool {
  return {
    name: "create_file",
    description: "Create one new UTF-8 text file inside the workspace. Refuses when the path already exists.",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "New file, relative to the workspace root." },
        content: { type: "string", description: "Initial file content." },
      },
      required: ["path", "content"],
    },
    readOnly: false,
    async execute(args, context) {
      const target = args.path;
      const content = args.content;
      if (typeof target !== "string" || target.length === 0 || target.endsWith("/") || target.endsWith("\\")) return fail("create_file", "'path' must name a file");
      if (typeof content !== "string") return fail("create_file", "'content' must be a string");
      if (Buffer.byteLength(content) > WRITE_FILE_MAX_BYTES) return fail("create_file", `content exceeds ${WRITE_FILE_MAX_BYTES} bytes`);
      let resolved: string;
      try { resolved = assertReadablePath(path.resolve(context.workspaceRoot, target), context.workspaceRoot, context.protectedRoots); }
      catch (error) { return fail("create_file", (error as Error).message); }
      try { await stat(resolved); return fail("create_file", `already exists: ${target}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("create_file", `cannot stat ${target}`); }
      const preview = content.split(/\r?\n/).slice(0, 40).join("\n");
      const denial = await approveExact("create_file", args, `Create ${target} (${Buffer.byteLength(content)} bytes)?\n${preview}\n本次批准 2 分钟内有效。`, context);
      if (denial) return denied("create_file", denial, context);
      const changed = sameFile(resolved, context.workspaceRoot, context.protectedRoots);
      if (changed) return fail("create_file", changed);
      try { await writeFile(resolved, content, { encoding: "utf8", flag: "wx" }); }
      catch (error) { return fail("create_file", `cannot create ${target}: ${(error as NodeJS.ErrnoException).code ?? "error"}`); }
      return { content: `created ${target}` };
    },
  };
}

/** Delete one existing file. Directories and recursive deletion are refused. */
export function createDeleteFileTool(): Tool {
  return {
    name: "delete_file",
    description: "Delete one existing file inside the workspace. Never deletes a directory.",
    parameters: { type: "object", properties: { path: { type: "string", description: "Existing file, relative to the workspace root." } }, required: ["path"] },
    readOnly: false,
    async execute(args, context) {
      const target = args.path;
      if (typeof target !== "string" || target.length === 0) return fail("delete_file", "'path' must name a file");
      let resolved: string;
      try { resolved = assertReadablePath(path.resolve(context.workspaceRoot, target), context.workspaceRoot, context.protectedRoots); }
      catch (error) { return fail("delete_file", (error as Error).message); }
      let info;
      try { info = await stat(resolved); }
      catch { return fail("delete_file", `no such file: ${target}`); }
      if (!info.isFile()) return fail("delete_file", `not a regular file: ${target}`);
      if (info.nlink > 1) return fail("delete_file", "hard-linked files are denied");
      // Read once; the preview and the stamp must describe the same bytes, or the
      // comparison degenerates into comparing a value with itself.
      const previewed = info.size <= WRITE_FILE_MAX_BYTES ? await readFile(resolved, "utf8") : undefined;
      const preview = previewed === undefined ? "文件超过预览上限" : previewed.split(/\r?\n/).slice(0, 40).join("\n");
      const denial = await approveExact("delete_file", args, `Delete ${target} (${info.size} bytes)?\n${preview}\n本次批准 2 分钟内有效。`, context);
      if (denial) return denied("delete_file", denial, context);
      const changed = sameFile(resolved, context.workspaceRoot, context.protectedRoots);
      if (changed) return fail("delete_file", changed);
      // The preview showed the operator *this* content. Deleting a file that has
      // since become something else destroys work they never saw.
      if (previewed !== undefined) {
        const drifted = await unchangedSinceApproval(resolved, contentStamp(previewed), "delete_file");
        if (drifted) return fail("delete_file", drifted);
      }
      await rm(resolved, { force: false, recursive: false });
      return { content: `deleted ${target}` };
    },
  };
}

/** Rename one existing file. The destination must not already exist. */
export function createRenameFileTool(): Tool {
  return {
    name: "rename_file",
    description: "Rename one existing file inside the workspace. Refuses when the destination exists.",
    parameters: {
      type: "object",
      properties: {
        from: { type: "string", description: "Existing file, relative to the workspace root." },
        to: { type: "string", description: "New path, relative to the workspace root." },
      },
      required: ["from", "to"],
    },
    readOnly: false,
    async execute(args, context) {
      const from = args.from;
      const to = args.to;
      if (typeof from !== "string" || typeof to !== "string" || !from || !to) return fail("rename_file", "'from' and 'to' must name files");
      let source: string;
      let destination: string;
      try {
        source = assertReadablePath(path.resolve(context.workspaceRoot, from), context.workspaceRoot, context.protectedRoots);
        destination = assertReadablePath(path.resolve(context.workspaceRoot, to), context.workspaceRoot, context.protectedRoots);
      } catch (error) { return fail("rename_file", (error as Error).message); }
      let info;
      try { info = await stat(source); }
      catch { return fail("rename_file", `no such file: ${from}`); }
      if (!info.isFile()) return fail("rename_file", `not a regular file: ${from}`);
      try { await stat(destination); return fail("rename_file", `destination exists: ${to}`); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return fail("rename_file", `cannot stat ${to}`); }
      const denial = await approveExact("rename_file", args, `Rename ${from} to ${to}?\n本次批准 2 分钟内有效。`, context);
      if (denial) return denied("rename_file", denial, context);
      const sourceChanged = sameFile(source, context.workspaceRoot, context.protectedRoots);
      const destinationChanged = sameFile(destination, context.workspaceRoot, context.protectedRoots);
      if (sourceChanged || destinationChanged) return fail("rename_file", sourceChanged ?? destinationChanged ?? "path changed");
      await rename(source, destination);
      return { content: `renamed ${from} to ${to}` };
    },
  };
}

const FILE_ACTIONS = {
  edit_file: createEditFileTool,
  patch_file: createPatchFileTool,
  create_file: createCreateFileTool,
  delete_file: createDeleteFileTool,
  rename_file: createRenameFileTool,
} as const;

/** Run several single-file actions after one approval of the exact manifest. */
export function createBatchFilesTool(): Tool {
  return {
    name: "batch_files",
    description: "Run up to 20 file actions after one approval of the complete manifest.",
    parameters: { type: "object", properties: { operations: { type: "array", items: { type: "object" } } }, required: ["operations"] },
    readOnly: false,
    async execute(args, context) {
      const operations = args.operations;
      if (!Array.isArray(operations) || operations.length === 0 || operations.length > 20) return fail("batch_files", "operations must contain 1 to 20 items");
      const manifest = operations.map((operation, index) => {
        const name = (operation as { tool?: unknown }).tool;
        if (typeof name !== "string" || !(name in FILE_ACTIONS)) throw new Error(`operation ${index + 1} has an unknown tool`);
        return `${index + 1}. ${name} ${JSON.stringify(operation)}`;
      });
      // Under a tier that already allowed this call there is nothing to ask, so
      // the missing channel is not a problem. Without this the `full-access`
      // batch path failed for the same reason the single-file tools did.
      const preApproved = context.preApproved === true;
      if (!context.approve && !preApproved) return fail("batch_files", "no approval channel is configured");
      const approvedManifest = manifest.join("\n");
      const askedAt = Date.now();
      const denial = await approveExact("batch_files", args, `Approve this exact batch?\n${approvedManifest}\n本次批准 2 分钟内有效，只对这份清单有效。`, context);
      if (denial) return denied("batch_files", denial, context);
      const expiresAt = askedAt + APPROVAL_TTL_MS;
      const lines: string[] = [];
      for (const [index, operation] of operations.entries()) {
        const name = (operation as { tool: keyof typeof FILE_ACTIONS }).tool;
        const { tool: _tool, ...childArgs } = operation as Record<string, unknown>;
        const result = await FILE_ACTIONS[name]().execute(childArgs, {
          ...context,
          grants: [{ tool: name, argumentsJson: JSON.stringify(childArgs), expiresAt }],
        });
        if (result.isError) return fail("batch_files", `operation ${index + 1} failed: ${result.content}`);
        lines.push(`${index + 1}. ${result.content}`);
      }
      return { content: lines.join("\n") };
    },
  };
}

/**
 * The set of tools advertised to the model, and the only path from a model's
 * {@link ToolCall} to an actual side effect.
 *
 * The registry deliberately does not consult permissions. It answers "can this
 * be executed", not "may it be" — approval is a separate layer that wraps the
 * caller, so that adding a tool can never silently widen what is authorised.
 *
 * A session may be constructed with an explicit `available` set. That is a
 * capability boundary, not a permission: a tool left out is absent, and absence
 * is enforced in both directions. `definitions()` never advertises it, and
 * `execute()` refuses it by name — hiding a tool from the prompt while still
 * running it on request would be denial wearing absence as a disguise, and the
 * cheap boundary only holds if the two agree.
 */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();
  readonly #available: ReadonlySet<string> | undefined;

  constructor(tools: readonly Tool[] = [], available?: readonly string[]) {
    this.#available = available ? new Set(available) : undefined;
    for (const tool of tools) this.register(tool);
    if (available) {
      for (const name of available) {
        if (!this.#tools.has(name)) throw new Error(`available tool is not registered: ${name}`);
      }
    }
  }

  /** Whether this session offers the tool at all. Absent is not the same as denied. */
  has(name: string): boolean {
    return this.#tools.has(name) && (!this.#available || this.#available.has(name));
  }

  register(tool: Tool): void {
    if (this.#tools.has(tool.name)) {
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    this.#tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.#tools.get(name);
  }

  list(): Tool[] {
    return [...this.#tools.values()];
  }

  definitions(): ToolDefinition[] {
    return this.list()
      .filter((tool) => this.has(tool.name))
      .map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  /** Execute one call, converting every failure into an error result. */
  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const tool = this.#tools.get(call.name);
    if (!tool) return fail("tool", `unknown tool: ${call.name}`);
    // Absent tools must not be reachable by name either. The wording is
    // deliberate: "not available" is a standing property of this session, not a
    // failure of this attempt, so the model does not retry it or hunt for a
    // workaround. (A boundary is only a boundary if its refusal is legible.)
    if (!this.has(call.name)) {
      return fail(call.name, "this tool is not available in this session; it is a policy boundary, not a transient failure");
    }
    let args: unknown;
    try {
      args = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
    } catch (error) {
      return fail(call.name, `arguments are not valid JSON: ${(error as Error).message}`);
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return fail(call.name, "arguments must be a JSON object");
    }
    let argumentProblem: string | undefined;
    try {
      argumentProblem = validateToolArguments(tool.parameters, args);
    } catch (error) {
      return fail(call.name, (error as Error).message);
    }
    if (argumentProblem) return fail(call.name, `invalid arguments: ${argumentProblem}`);
    const match = decide(context.rules ?? DEFAULT_RULES, call.name, args as Record<string, unknown>);
    if (match.decision === "deny" && tool.readOnly !== true) {
      // Attribute the refusal to the rule that made it, so a denial can be
      // explained by inspecting the audit rather than by reading this code.
      await context.audit?.({
        tool: call.name,
        decision: "denied",
        reason: match.reason ?? "denied by rule",
        rule: match.rule?.id ?? null,
      });
      return fail(call.name, match.reason ?? "denied by rule");
    }
    try {
      return await tool.execute(args as Record<string, unknown>, {
        ...context,
        // Passed per call rather than stored on the context the caller supplied,
        // so one allowed call cannot leak "pre-approved" into the next one.
        preApproved: match.decision === "allow",
      });
    } catch (error) {
      return fail(call.name, `threw: ${(error as Error).message}`);
    }
  }
}
