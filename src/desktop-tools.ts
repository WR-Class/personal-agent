import { lstat, opendir } from 'node:fs/promises';
import path from 'node:path';
import type { RuntimeActivity } from './runtime.ts';
import { assertReadablePath, canonicalPath, sensitivePathName } from './security-config.ts';
import { resolveTier } from './tiers.ts';
import { RULE_TIERS } from './rule-table.ts';
import { ToolRegistry, createReadFileTool, createCreateFileTool, createEditFileTool, createPatchFileTool } from './tools.ts';
import type { Tool, ToolContext } from './tools.ts';

/** Trusted main-process values only. No CLI config, commands, MCP or skill loading. */
export interface DesktopToolOptions {
  workspaceRoot: string;
  writable: boolean;
  check: () => void;
  approve: (prompt: string, signal?: AbortSignal) => Promise<boolean>;
  onActivity?: (event: RuntimeActivity) => void;
  signal?: AbortSignal;
}

function check(options: DesktopToolOptions, signal?: AbortSignal): void {
  options.signal?.throwIfAborted();
  signal?.throwIfAborted();
  options.check();
}

/** Reject links in every path component, not just a leaf resolving outside the root. */
async function checkedPath(target: string, context: ToolContext): Promise<string> {
  const lexical = path.resolve(context.workspaceRoot, target);
  const actual = assertReadablePath(lexical, context.workspaceRoot, context.protectedRoots);
  const root = canonicalPath(context.workspaceRoot);
  // Resolve policy first, then inspect the lexical ancestors for links.
  let cursor = path.parse(lexical).root;
  for (const part of lexical.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      const info = await lstat(cursor);
      if (info.isSymbolicLink()) throw new Error('linked paths are denied');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
  }
  if (canonicalPath(context.workspaceRoot) !== root || canonicalPath(lexical) !== actual) throw new Error('path changed');
  return actual;
}

function directoryTool(): Tool {
  return {
    name: 'list_directory',
    description: 'List one workspace directory without recursion. Hidden, sensitive and linked entries are omitted; at most 500 entries are examined.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
    readOnly: true,
    async execute(args, context) {
      if (typeof args.path !== 'string' || !args.path) throw new Error('path must name a directory');
      const resolved = await checkedPath(args.path, context);
      const entries: { name: string; type: 'directory' | 'file' }[] = [];
      let scanned = 0, truncated = false;
      const directory = await opendir(resolved);
      for await (const entry of directory) {
        context.signal?.throwIfAborted();
        if (++scanned > 500) { truncated = true; break; }
        if (entry.name.startsWith('.') || sensitivePathName(entry.name) || entry.isSymbolicLink()) continue;
        try {
          const candidate = await checkedPath(path.join(resolved, entry.name), context);
          const info = await lstat(candidate);
          if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1)) continue;
          if (info.isFile() || info.isDirectory()) entries.push({ name: entry.name, type: info.isDirectory() ? 'directory' : 'file' });
        } catch { /* A denied or concurrently removed entry is not disclosed. */ }
      }
      return { content: JSON.stringify({ entries, truncated }) };
    },
  };
}

export function createDesktopTools(options: DesktopToolOptions): { tools: ToolRegistry; rules: ReturnType<typeof resolveTier>['rules'] } {
  if (typeof options.workspaceRoot !== 'string' || !path.isAbsolute(options.workspaceRoot) ||
      typeof options.writable !== 'boolean' || typeof options.check !== 'function' || typeof options.approve !== 'function') {
    throw new Error('invalid trusted desktop tool options');
  }
  check(options);
  const workspaceRoot = canonicalPath(options.workspaceRoot);
  const tier = resolveTier(options.writable ? 'workspace-write' : 'read-only');
  const originals = [createReadFileTool(), directoryTool(),
    ...(options.writable ? [createCreateFileTool(), createEditFileTool(), createPatchFileTool()] : [])];
  const tools = originals.map((tool): Tool => ({ ...tool,
    async execute(args, context) {
      check(options, context.signal);
      if (canonicalPath(options.workspaceRoot) !== workspaceRoot) throw new Error('workspace changed');
      const bounded: ToolContext = { ...context, workspaceRoot, readableRoots: [], unrestrictedWrites: false,
        grants: [], preApproved: false,
        approve: async prompt => {
          check(options, context.signal);
          if (typeof args.path === 'string') await checkedPath(args.path, bounded);
          check(options, context.signal);
          const approved = await options.approve(prompt, context.signal);
          check(options, context.signal);
          if (canonicalPath(options.workspaceRoot) !== workspaceRoot) throw new Error('workspace changed');
          if (typeof args.path === 'string') await checkedPath(args.path, bounded);
          check(options, context.signal);
          return approved === true;
        },
      };
      if (typeof args.path === 'string') await checkedPath(args.path, bounded);
      check(options, context.signal);
      const result = await tool.execute(args, bounded);
      check(options, context.signal);
      return result;
    },
  }));
  return { tools: new ToolRegistry(tools, tools.map(tool => tool.name)), rules: [
    { id: 'desktop.list-directory', tool: 'list_directory', decision: 'allow', tier: RULE_TIERS.USER, priority: 950 },
    ...tier.rules,
  ] };
}
