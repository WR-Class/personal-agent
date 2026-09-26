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

import { open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import type { JsonSchema, ToolCall, ToolDefinition } from "./types.ts";
import type { ToolEnvironment } from "./tool-environment.ts";
import { isIssuedToolEnvironment } from "./tool-environment.ts";
import { assertReadablePath } from "./security-config.ts";
import { filePolicy } from "./file-policy.ts";
import type { FileGrant } from "./file-policy.ts";
import { readBoundedUtf8 } from "./bounded-read.ts";

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
  signal?: AbortSignal;
  /** Asked before the one write tool replaces an existing file. */
  approve?(prompt: string): Promise<boolean>;
  /** Exact grants already approved by a parent operation. */
  grants?: readonly FileGrant[];
  /** Records a denial without changing the conversation. */
  audit?(event: { tool: string; decision: "denied" | "expired"; reason: string }): Promise<void>;
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

export async function denied(name: string, reason: string, context: ToolContext): Promise<ToolResult> {
  await context.audit?.({ tool: name, decision: reason === "approval expired" ? "expired" : "denied", reason });
  return fail(name, reason);
}

/** Ask once unless this exact call already has an unexpired grant. */
export async function approveExact(name: string, args: unknown, prompt: string, context: ToolContext): Promise<string | undefined> {
  const now = Date.now();
  const expected = JSON.stringify(args);
  const granted = context.grants?.some((grant) => grant.tool === name && grant.argumentsJson === expected && now <= grant.expiresAt) === true;
  if (granted) return undefined;
  if (!context.approve) return "no approval channel is configured";
  const approved = await context.approve(prompt);
  if (Date.now() - now > APPROVAL_TTL_MS) return "approval expired";
  if (!approved) return "operator declined";
  return undefined;
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

async function readBoundedFile(filePath: string, maxBytes: number): Promise<string> {
  const handle = await open(filePath, "r");
  try {
    return await readBoundedUtf8(fileChunks(handle), maxBytes, "file");
  } finally {
    await handle.close();
  }
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

export function createReadFileTool(): Tool {
  return {
    name: "read_file",
    description:
      "Read a UTF-8 text file inside the workspace. `path` is relative to the workspace root (absolute paths inside it also work).",
    parameters: {
      type: "object",
      properties: {
        path: { type: "string", description: "File to read, relative to the workspace root." }
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
        resolved = assertReadablePath(path.resolve(context.workspaceRoot, target), context.workspaceRoot, context.protectedRoots);
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
      if (info.size > READ_FILE_MAX_BYTES) {
        return fail(
          "read_file",
          `${target} is ${info.size} bytes, over the ${READ_FILE_MAX_BYTES}-byte limit`
        );
      }
      try {
        return { content: await readBoundedFile(resolved, READ_FILE_MAX_BYTES) };
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
      const preview = info.size <= WRITE_FILE_MAX_BYTES ? (await readFile(resolved, "utf8")).split(/\r?\n/).slice(0, 40).join("\n") : "文件超过预览上限";
      const denial = await approveExact("delete_file", args, `Delete ${target} (${info.size} bytes)?\n${preview}\n本次批准 2 分钟内有效。`, context);
      if (denial) return denied("delete_file", denial, context);
      const changed = sameFile(resolved, context.workspaceRoot, context.protectedRoots);
      if (changed) return fail("delete_file", changed);
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
      if (!context.approve) return fail("batch_files", "no approval channel is configured");
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
 */
export class ToolRegistry {
  readonly #tools = new Map<string, Tool>();

  constructor(tools: readonly Tool[] = []) {
    for (const tool of tools) this.register(tool);
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
    return this.list().map(({ name, description, parameters }) => ({ name, description, parameters }));
  }

  /** Execute one call, converting every failure into an error result. */
  async execute(call: ToolCall, context: ToolContext): Promise<ToolResult> {
    const tool = this.#tools.get(call.name);
    if (!tool) return fail("tool", `unknown tool: ${call.name}`);
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
    if (filePolicy(call.name) === "deny" && tool.readOnly !== true) return fail(call.name, "side-effect tools are disabled until approval is implemented");
    try {
      return await tool.execute(args as Record<string, unknown>, context);
    } catch (error) {
      return fail(call.name, `threw: ${(error as Error).message}`);
    }
  }
}
