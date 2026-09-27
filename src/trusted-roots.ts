/**
 * Remembered readable roots (D35).
 *
 * Path confinement was the one axis with no way to widen it: `workspace` was
 * the only readable root and nothing could add another. That is what makes
 * reviewing someone else's code, or looking at a binary outside the project,
 * impossible rather than merely inconvenient. This module adds the missing
 * direction without weakening anything else.
 *
 * Where it lives matters as much as what it does. The store sits in the agent
 * home, next to the gene library, and never in the workspace: a trust file
 * inside the repository would be attacker-controlled, so cloning a hostile repo
 * could ship its own grant. grok-cli keys remembered trust by realpath and
 * stores it at `~/.grok/workspace-trust.json` for exactly this reason.
 *
 * Read at decision time, never snapshotted. qwen-code re-reads trust on every
 * call rather than caching it, so a grant cannot be mutated under a session
 * that already decided what it may reach.
 *
 * Writes are deliberately not covered. `assertReadablePath` is the single gate
 * for reads and writes, so widening it in place would widen both; the two are
 * separated at the call site instead. Being able to read a directory is not
 * being able to change it, and keeping those apart is the whole point of
 * offering this at all.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { canonicalPath, isWithin, sensitivePathName } from "./security-config.ts";

export interface TrustEntry {
  /** Canonical path of the granted root. */
  readonly root: string;
  /** ISO timestamp of when it was granted, kept so the file is auditable by eye. */
  readonly grantedAt: string;
}

interface TrustFile {
  readonly version: number;
  readonly readableRoots: readonly TrustEntry[];
}

const TRUST_VERSION = 1;

function trustPath(agentHome: string): string {
  return path.join(agentHome, "trust.json");
}

function parse(text: string, file: string): TrustFile {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    // Refuse rather than default to empty: silently treating a corrupt trust
    // file as "no roots" would look identical to "reads are still confined",
    // which is the wrong answer to give when the file was meant to widen them.
    throw new Error(`trust file is not valid JSON: ${file}: ${(error as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null) throw new Error(`trust file must be an object: ${file}`);
  const roots = (parsed as { readableRoots?: unknown }).readableRoots;
  if (roots === undefined) return { version: TRUST_VERSION, readableRoots: [] };
  if (!Array.isArray(roots)) throw new Error(`trust file readableRoots must be an array: ${file}`);
  return {
    version: TRUST_VERSION,
    readableRoots: roots.map((entry): TrustEntry => {
      if (typeof entry !== "object" || entry === null) throw new Error(`trust entry must be an object: ${file}`);
      const { root, grantedAt } = entry as { root?: unknown; grantedAt?: unknown };
      if (typeof root !== "string" || !path.isAbsolute(root)) throw new Error(`trust entry root must be an absolute path: ${file}`);
      return { root: canonicalPath(root), grantedAt: typeof grantedAt === "string" ? grantedAt : "" };
    }),
  };
}

/** Read the granted roots. ENOENT means none were ever granted, not an error. */
export async function readTrustedRoots(agentHome: string): Promise<readonly string[]> {
  const file = trustPath(agentHome);
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return parse(text, file).readableRoots.map((entry) => entry.root);
}

/** Grant one root, keeping the file sorted and de-duplicated. */
export async function grantReadableRoot(agentHome: string, root: string, now = new Date()): Promise<string> {
  const absolute = path.resolve(root);
  if (!path.isAbsolute(absolute)) throw new Error("readable root must be an absolute path");
  if (path.dirname(absolute) === absolute) throw new Error("refuses filesystem root");
  const canonical = canonicalPath(absolute);
  const existing = await readTrustedRoots(agentHome);
  const kept = existing.filter((entry) => entry !== canonical);
  const next: TrustFile = {
    version: TRUST_VERSION,
    readableRoots: [...kept, canonical].sort().map((entry) => ({ root: entry, grantedAt: now.toISOString() })),
  };
  await mkdir(agentHome, { recursive: true });
  await writeFile(trustPath(agentHome), `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  return canonical;
}

/** Retire one root. Returns whether it had been granted. */
export async function revokeReadableRoot(agentHome: string, root: string): Promise<boolean> {
  const canonical = canonicalPath(path.resolve(root));
  const existing = await readTrustedRoots(agentHome);
  if (!existing.includes(canonical)) return false;
  const next: TrustFile = {
    version: TRUST_VERSION,
    readableRoots: existing.filter((entry) => entry !== canonical).map((entry) => ({ root: entry, grantedAt: "" })),
  };
  await writeFile(trustPath(agentHome), `${JSON.stringify(next, null, 2)}\n`, { encoding: "utf8", flag: "w" });
  return true;
}

/**
 * Whether a read at `actual` is allowed. Returns undefined when it is.
 *
 * The sensitive-name check is applied *inside* an added root too. An added root
 * means "this directory tree is readable", not "every file in it is", and
 * people will read it as the narrower claim unless something says otherwise.
 * A name list cannot be a boundary, but leaving it out of the added roots would
 * make it weaker than it is inside the workspace, which would be a strange
 * thing to ship.
 */
export function checkReadable(actual: string, workspace: string, extraReadable: readonly string[]): string | undefined {
  if (isWithin(workspace, actual)) return undefined;
  for (const root of extraReadable) {
    if (isWithin(root, actual)) {
      const parts = actual.split(/[\\/]/);
      if (parts.some((part) => sensitivePathName(part))) return "sensitive path is denied";
      return undefined;
    }
  }
  return "path escapes the workspace";
}
