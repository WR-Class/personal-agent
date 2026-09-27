/**
 * Running a command (D46).
 *
 * Every mature agent product surveyed gives the model a shell: crush ships a
 * `bash` tool whose only required parameter is `command: string`, and aider,
 * claude-code, codex, gemini-cli, goose, grok-cli, opencode and qwen-code all
 * have the equivalent. None of them make the dangerous form unrepresentable,
 * because that is not achievable — the whole value of a shell is that it can run
 * anything. What they do instead is decide *whether to ask*, in tiers.
 *
 * An earlier round of this project went the other way: a fixed list of read-only
 * tools, argv arrays, no shell, on the argument that `&&` and `|` then become
 * unrepresentable rather than filtered. That argument was sound and the result
 * was useless — an agent that cannot run a command cannot build, test, inspect
 * or repair anything, which is the entire job. It also confused two different
 * things: *how a command is passed* with *whether a command is allowed*. The
 * first can be made safe and the second cannot, so this file does the first and
 * leaves the second to the permission tier.
 *
 * So: the command really is a shell command, run through the platform shell,
 * because that is what makes `git log --oneline | head` work. The tier decides
 * whether it runs without asking (`full-access`), asks once per call
 * (`workspace-write`), or is not offered at all (`read-only`, where the tool is
 * absent rather than refused).
 */

import { spawn } from "node:child_process";
import type { ToolEnvironment } from "./tool-environment.ts";

/** Output is capped: a build log or a recursive listing can dwarf any context. */
export const SHELL_MAX_OUTPUT_BYTES = 64 * 1024;
export const SHELL_TIMEOUT_MS = 120_000;
export const SHELL_MAX_LINES = 2_000;

export interface ShellResult {
  readonly content: string;
  readonly isError?: boolean;
}

/**
 * The shell to run a command through.
 *
 * Windows has no `/bin/sh`, so the choice is `cmd.exe`, which is what the
 * platform's own tooling assumes. A Unix shell is deliberately not emulated:
 * pretending that `ls` exists on Windows would produce failures whose cause is
 * this file rather than the command, and the model reading the error would draw
 * the wrong conclusion about the machine.
 */
function shellFor(): { executable: string; args: (command: string) => string[] } {
  if (process.platform === "win32") {
    return { executable: process.env.ComSpec ?? "cmd.exe", args: (command) => ["/d", "/s", "/c", command] };
  }
  return { executable: "/bin/sh", args: (command) => ["-c", command] };
}

/**
 * Run one command and return what it printed.
 *
 * A non-zero exit is reported as a normal result rather than a thrown error:
 * `git log` on a repository with no commits exits non-zero and that is
 * information, not a fault. The model needs to see the failing output to
 * correct itself, which is exactly how a person works — measured, five
 * deliberately wrong `git` invocations each produced a message naming the
 * offending argument, and the correct form was simply `exit=0`.
 */
export async function runShellCommand(
  command: string,
  environment: ToolEnvironment,
  signal?: AbortSignal,
): Promise<ShellResult> {
  if (command.trim() === "") return { content: "command is empty", isError: true };

  const shell = shellFor();
  return await new Promise<ShellResult>((resolve) => {
    const child = spawn(shell.executable, shell.args(command), {
      cwd: environment.cwd,
      // The agent's own environment, never the parent's. The parent's HOME is the
      // operator's, so inheriting it would let a command read and write the
      // operator's dotfiles and caches while every file tool still reported the
      // workspace as the boundary. This is the same environment the other tools
      // are given, so a command and a file tool agree about where `~` is.
      env: environment.env as NodeJS.ProcessEnv,
      // No `shell: true` here: the platform shell is spawned directly so the
      // command string is its *input*, not an extra layer of quoting that would
      // have to be parsed twice and would break on spaces in paths.
      shell: false,
      windowsHide: true,
      signal,
    });

    // Buffered and decoded once, for the reason measured earlier: a multi-byte
    // character split across two chunks becomes replacement characters if each
    // chunk is decoded on its own.
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    let settled = false;

    const finish = (result: ShellResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    const timer = setTimeout(() => {
      child.kill();
      finish({
        content: `command timed out after ${SHELL_TIMEOUT_MS}ms and was killed:\n${command}`,
        isError: true,
      });
    }, SHELL_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (outBytes >= SHELL_MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      outBytes += chunk.length;
      outChunks.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => errChunks.push(chunk));

    child.on("error", (error) =>
      finish({ content: `could not run the shell: ${error.message}`, isError: true }));

    child.on("close", (code) => {
      const out = decode(Buffer.concat(outChunks));
      const err = decode(Buffer.concat(errChunks));
      const parts: string[] = [];
      if (out.trim() !== "") parts.push(out.trimEnd());
      if (err.trim() !== "") parts.push(`[stderr]\n${err.trimEnd()}`);
      if (parts.length === 0) parts.push("(no output)");
      parts.push(`[exit code: ${code ?? "unknown"}]`);
      // A truncation notice is appended rather than silently cutting: the model
      // must know its view is partial, or it will reason from half a listing.
      if (truncated) parts.push(`[output truncated at ${SHELL_MAX_OUTPUT_BYTES} bytes]`);
      const body = clampLines(parts.join("\n"));
      finish({ content: body });
    });
  });
}

function clampLines(text: string): string {
  const lines = text.split("\n");
  if (lines.length <= SHELL_MAX_LINES) return text;
  return [...lines.slice(0, SHELL_MAX_LINES), `[... ${lines.length - SHELL_MAX_LINES} more lines]`].join("\n");
}

/** Decode a complete buffer, preferring GBK only when UTF-8 is visibly damaged. */
function decode(chunk: Buffer): string {
  const asUtf8 = chunk.toString("utf8");
  if (!asUtf8.includes("\uFFFD")) return asUtf8;
  try {
    const decoded = new TextDecoder("gbk").decode(chunk);
    return decoded.includes("\uFFFD") ? asUtf8 : decoded;
  } catch {
    return asUtf8;
  }
}
