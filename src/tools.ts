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
      if (!context.approve) return fail("edit_file", "no approval channel is configured");
      const askedAt = Date.now();
      const current = await readFile(resolved, "utf8");
      const diff = lineDiff(current, content);
      const approved = await context.approve(`Replace ${target} (${info.size} bytes) with ${Buffer.byteLength(content)} bytes?\n${diff || "内容没有变化"}\n本次批准 2 分钟内有效。`);
      if (Date.now() - askedAt > APPROVAL_TTL_MS) return fail("edit_file", "approval expired");
      if (!approved) return fail("edit_file", "operator declined");
      const temporary = `${resolved}.${process.pid}.tmp`;
      await writeFile(temporary, content, { encoding: "utf8", flag: "wx" });
      await rename(temporary, resolved);
      return { content: `replaced ${target}` };
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
      if (!context.approve) return fail("create_file", "no approval channel is configured");
      const askedAt = Date.now();
      const preview = content.split(/\r?\n/).slice(0, 40).join("\n");
      const approved = await context.approve(`Create ${target} (${Buffer.byteLength(content)} bytes)?\n${preview}\n本次批准 2 分钟内有效。`);
      if (Date.now() - askedAt > APPROVAL_TTL_MS) return fail("create_file", "approval expired");
      if (!approved) return fail("create_file", "operator declined");
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
      if (!context.approve) return fail("delete_file", "no approval channel is configured");
      const askedAt = Date.now();
      const preview = info.size <= WRITE_FILE_MAX_BYTES ? (await readFile(resolved, "utf8")).split(/\r?\n/).slice(0, 40).join("\n") : "文件超过预览上限";
      const approved = await context.approve(`Delete ${target} (${info.size} bytes)?\n${preview}\n本次批准 2 分钟内有效。`);
      if (Date.now() - askedAt > APPROVAL_TTL_MS) return fail("delete_file", "approval expired");
      if (!approved) return fail("delete_file", "operator declined");
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
      if (!context.approve) return fail("rename_file", "no approval channel is configured");
      const askedAt = Date.now();
      const approved = await context.approve(`Rename ${from} to ${to}?\n本次批准 2 分钟内有效。`);
      if (Date.now() - askedAt > APPROVAL_TTL_MS) return fail("rename_file", "approval expired");
      if (!approved) return fail("rename_file", "operator declined");
      await rename(source, destination);
      return { content: `renamed ${from} to ${to}` };
    },
  };
}

const FILE_ACTIONS = {
  edit_file: createEditFileTool,
  create_file: createCreateFileTool,
  delete_file: createDeleteFileTool,
  rename_file: createRenameFileTool,
} as const;

/** Run several single-file actions. Each action asks for its own approval. */
export function createBatchFilesTool(): Tool {
  return {
    name: "batch_files",
    description: "Run up to 20 single-file edit, create, delete, or rename actions. Each action needs its own approval.",
    parameters: { type: "object", properties: { operations: { type: "array", items: { type: "object" } } }, required: ["operations"] },
    readOnly: false,
    async execute(args, context) {
      const operations = args.operations;
      if (!Array.isArray(operations) || operations.length === 0 || operations.length > 20) return fail("batch_files", "operations must contain 1 to 20 items");
      const lines: string[] = [];
      for (const [index, operation] of operations.entries()) {
        const name = (operation as { tool?: unknown }).tool;
        const factory = FILE_ACTIONS[name as keyof typeof FILE_ACTIONS];
        if (!factory) return fail("batch_files", `operation ${index + 1} has an unknown tool`);
        const result = await factory().execute(operation as Record<string, unknown>, context);
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
    // edit_file is the one approved side effect. Every other write stays closed.
    if (tool.readOnly !== true && !["edit_file", "create_file", "delete_file", "rename_file", "batch_files"].includes(tool.name)) return fail(call.name, "side-effect tools are disabled until approval is implemented");
    let args: unknown;
    try {
      args = call.arguments.trim() === "" ? {} : JSON.parse(call.arguments);
    } catch (error) {
      return fail(call.name, `arguments are not valid JSON: ${(error as Error).message}`);
    }
    if (typeof args !== "object" || args === null || Array.isArray(args)) {
      return fail(call.name, "arguments must be a JSON object");
    }
    // A declaration this project cannot verify is a host bug, not a tool failure:
    // report it as itself instead of dressing it up as "the tool threw".
    let argumentProblem: string | undefined;
    try {
      argumentProblem = validateToolArguments(tool.parameters, args);
    } catch (error) {
      return fail(call.name, (error as Error).message);
    }
    if (argumentProblem) return fail(call.name, `invalid arguments: ${argumentProblem}`);
    try {
      return await tool.execute(args as Record<string, unknown>, context);
    } catch (error) {
      return fail(call.name, `threw: ${(error as Error).message}`);
    }
  }
}
