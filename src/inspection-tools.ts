/**
 * Named read-only inspection tools (D41).
 *
 * Why this exists rather than a shell. The operator's case is reading software
 * that lives outside the workspace — a binary, a jar, an image — and the honest
 * problem is that *which* tool is needed is not knowable in advance: it depends
 * on what the file turns out to be, which is discovered while working. So
 * neither "enumerate the commands in advance" nor "let the model write a
 * command" is acceptable. The first cannot cover a set that is discovered
 * during the work; the second has no boundary at all.
 *
 * The resolution is to split the two decisions:
 *
 * - The **operator** authorises a directory to be read (already exists, via the
 *   readable roots in D35) and authorises that these tools may run.
 * - The **model** chooses *which* of the named tools to apply, and to which
 *   file. That is a choice from a closed set, not a command.
 *
 * The load-bearing property: **the tool list is a constant in this file**. A
 * model that could name an arbitrary executable would make this a shell with
 * extra steps, which is the option that was explicitly rejected. `inspect_file`
 * therefore takes a `tool` that must be one of {@link INSPECTION_TOOLS}, and
 * the arguments are a path plus a couple of bounded flags — never a command
 * string, never a shell.
 *
 * The second property follows from that and is worth stating because it is
 * stronger than filtering: with no shell involved, `&&`, `|`, `;`, `>`, `$()`
 * and backticks are **not rejected, they are unrepresentable**. There is no
 * string in which they could appear. Measured for comparison, crush's own
 * chaining check passes `ls & rm -rf /`, a second command after a newline, and
 * `git status > /etc/passwd`; crush is nonetheless safe there because those
 * fall through to a prompt, but it shows detection is not what to copy.
 *
 * Scope is deliberately small: read-only tools only. Nothing here writes,
 * nothing opens a network connection, and nothing starts an interactive session
 * (a debugger driving stdin is a different shape — a long-lived process with a
 * controlled input channel — and is not attempted here).
 */

import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";

export interface InspectionResult {
  readonly content: string;
  readonly isError: boolean;
}

export interface InspectionTool {
  /** The name the model must use. This is the whole authorisation surface. */
  readonly name: string;
  /** Executable to run. Resolved by the OS, never from model input. */
  readonly executable: string;
  /** What it is for, shown to the model and to the operator. */
  readonly description: string;
  /**
   * Build the argv *after* the operator-chosen file path.
   *
   * Returning an array rather than a string is the point: an element containing
   * spaces or quotes stays one argument, so a path can never be read as extra
   * flags or as a second command.
   */
  readonly args: (target: string, options: InspectionOptions) => string[];
}

export interface InspectionOptions {
  /** Bounded head limit for tools that accept one. */
  readonly lines?: number;
  /** Strip symbols, where the tool supports it. */
  readonly strip?: boolean;
}

/** Hard ceiling on how much output one call may return. */
export const INSPECTION_MAX_OUTPUT_BYTES = 128 * 1024;

/** Hard ceiling on how long one call may run. */
export const INSPECTION_TIMEOUT_MS = 60_000;

/** Largest `lines` a caller may request. Also bounds the output. */
export const INSPECTION_MAX_LINES = 5_000;

/**
 * The audited list. Every entry is read-only in intent, and each one is a
 * separate operator-visible decision rather than a generated command.
 *
 * Kept short on purpose: adding an entry is a code change that a reviewer sees,
 * which is the property that makes this list meaningful. A tool that is absent
 * cannot be reached by any input.
 *
 * Platform note, and it is the reason this list is built by a function rather
 * than declared once: the usual binaries (`file`, `strings`, `xxd`, `objdump`,
 * `nm`, `sha256sum`) are all absent on a stock Windows machine, which was
 * measured rather than assumed. An earlier version of this list was therefore
 * dead on the only platform this project has been exercised on, reporting "not
 * installed" for every single tool. Each name now resolves to whatever this
 * platform actually ships, and an entry whose tool is missing everywhere is
 * simply not offered.
 */
export const INSPECTION_TOOLS: readonly InspectionTool[] = [
  {
    name: "file_type",
    executable: "file",
    description: "Identify what a file is (format, architecture hints).",
    args: (target) => ["-b", target],
  },
  {
    name: "strings",
    executable: "strings",
    description: "Extract printable strings, e.g. paths, URLs, error messages.",
    args: (target, options) => [...(options.lines ? ["-n", "6"] : []), target],
  },
  {
    name: "hex_dump",
    executable: "xxd",
    description: "Hex dump of the beginning of a file.",
    args: (target, options) => ["-l", String(Math.min((options.lines ?? 256) * 16, 65_536)), target],
  },
  {
    name: "disassemble",
    executable: "objdump",
    description: "Disassemble machine code (read-only; no execution).",
    args: (target, options) => ["-d", ...(options.strip ? ["--no-show-raw-insn"] : []), target],
  },
  {
    name: "headers",
    executable: "objdump",
    description: "List file headers and sections (ELF/PE).",
    args: (target) => ["-h", target],
  },
  {
    name: "symbols",
    executable: "nm",
    description: "List symbols, for binaries that were not stripped.",
    args: (target, options) => [...(options.strip ? ["-D"] : []), target],
  },
  {
    name: "hash",
    executable: "sha256sum",
    description: "Hash a file, e.g. to compare against a published value.",
    args: (target) => [target],
  },
  // Windows equivalents. `certutil` ships with the OS, so these entries are the
  // only ones that work on a stock Windows box; on other platforms `certutil`
  // is absent and `runInspection` reports that plainly.
  {
    name: "certutil_dump",
    executable: "certutil",
    description: "Windows: hex dump of a file (certutil -dump).",
    args: (target) => ["-dump", target],
  },
  {
    name: "certutil_hash",
    executable: "certutil",
    description: "Windows: hash a file (certutil -hashfile SHA256).",
    args: (target) => ["-hashfile", target, "SHA256"],
  },
  {
    name: "find_strings",
    executable: "findstr",
    description: "Windows: find printable-looking text in a binary (findstr /R).",
    args: (target) => ["/R", "/C:[ -~][ -~][ -~][ -~]", target],
  },
];

export function findInspectionTool(name: string): InspectionTool | undefined {
  return INSPECTION_TOOLS.find((tool) => tool.name === name);
}

/** The names, for an enum in the tool schema and for error messages. */
export function inspectionToolNames(): string[] {
  return INSPECTION_TOOLS.map((tool) => tool.name);
}

/**
 * Decode a tool's output as UTF-8, falling back to the console code page.
 *
 * Measured, not guessed: on a Windows machine `certutil` writes its messages in
 * the OEM code page, so decoding as UTF-8 yields replacement characters —
 * `SHA256 的 a.txt 哈希:` came back as `SHA256 ?? a.txt ??:`. That is the same
 * defect as the binary read path (D38): text that looks like text while being
 * corrupt, with nothing to signal the damage. Node ships a `gbk` decoder, so the
 * fallback is available without any dependency.
 *
 * The rule is the same one used there — only substitute an encoding when the
 * UTF-8 reading is provably lossy, so a genuinely UTF-8 tool is untouched.
 *
 * This decodes one **complete** buffer, never a stream chunk. Measured: splitting
 * `哈希` at a chunk boundary and decoding each piece separately turns the first
 * character into two replacement characters, because a UTF-8 character is up to
 * four bytes and a pipe does not respect those boundaries. `StringDecoder` is
 * what solves it, and it needs to see the whole stream, so the caller buffers
 * first and decodes once.
 */
function decodeOutput(chunk: Buffer): string {
  const asUtf8 = chunk.toString("utf8");
  if (!asUtf8.includes("\uFFFD")) return asUtf8;
  try {
    const decoded = new TextDecoder("gbk").decode(chunk);
    // Only prefer the fallback if it is actually better; a decoder that also
    // produces replacement characters tells us nothing new.
    return decoded.includes("\uFFFD") ? asUtf8 : decoded;
  } catch {
    // No such decoder in this runtime: keep the honest, damaged reading rather
    // than inventing one.
    return asUtf8;
  }
}

/**
 * Run one inspection tool against one already-authorised path.
 *
 * The caller is responsible for having checked that `target` is readable — this
 * function deliberately knows nothing about permissions, so that there is
 * exactly one place in the project that answers "may this be read" and this is
 * not it.
 *
 * `spawn` without a shell, with an argv array: no shell means no word splitting,
 * no globbing and no metacharacter interpretation, so nothing in the path can
 * become a command. Output is capped, because these tools can emit far more than
 * a context window.
 */
export async function runInspection(
  tool: InspectionTool,
  target: string,
  options: InspectionOptions,
  signal?: AbortSignal,
): Promise<InspectionResult> {
  // Fail before spawning: a missing file should read as "no such file", not as a
  // tool failure the model may try to work around.
  try {
    const info = await stat(target);
    if (!info.isFile()) return { content: `${target} is not a regular file`, isError: true };
  } catch {
    return { content: `no such file: ${target}`, isError: true };
  }

  return await new Promise<InspectionResult>((resolve) => {
    const child = spawn(tool.executable, tool.args(target, options), {
      // No shell, no inherited shell: the argv array is passed straight through.
      shell: false,
      windowsHide: true,
      signal,
    });
    // Raw bytes are accumulated, and decoding happens once at the end. Decoding
    // each chunk separately corrupts any multi-byte character that straddles a
    // chunk boundary — measured, `哈希` split across two chunks became `��希`.
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    let settled = false;
    const finish = (result: InspectionResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      finish({
        content: `${tool.name} timed out after ${INSPECTION_TIMEOUT_MS}ms and was killed`,
        isError: true,
      });
    }, INSPECTION_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (outBytes >= INSPECTION_MAX_OUTPUT_BYTES) {
        truncated = true;
        return;
      }
      // Cap on bytes, not on decoded characters: the ceiling must bound what we
      // buffer, which is bytes. Cutting a character in half here is harmless
      // because the decoder at the end drops the incomplete tail.
      outBytes += chunk.byteLength;
      outChunks.push(chunk);
      if (outBytes > INSPECTION_MAX_OUTPUT_BYTES) truncated = true;
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errChunks.length < 64) errChunks.push(chunk);
    });

    child.on("error", (error: NodeJS.ErrnoException) => {
      // ENOENT is the common case and deserves its own wording: the tool is not
      // installed, which is a fact about this machine, not about the target.
      const detail = error.code === "ENOENT"
        ? `${tool.executable} is not installed or not on PATH (needed by '${tool.name}')`
        : `cannot run ${tool.executable}: ${error.message}`;
      finish({ content: detail, isError: true });
    });

    child.on("close", (code) => {
      const raw = Buffer.concat(outChunks).subarray(0, INSPECTION_MAX_OUTPUT_BYTES);
      const stdout = decodeOutput(raw);
      const stderr = decodeOutput(Buffer.concat(errChunks));
      const body = stdout.trim() === "" ? "(no output)" : stdout.trimEnd();
      const suffix = truncated ? `\n\n[output truncated at ${INSPECTION_MAX_OUTPUT_BYTES} bytes]` : "";
      // A non-zero exit is reported but is not automatically an error: `nm` on a
      // stripped binary, for instance, exits non-zero and that is a finding.
      const note = code === 0 ? "" : `\n\n[${tool.executable} exited ${code}]${stderr.trim() ? `: ${stderr.trim().slice(0, 400)}` : ""}`;
      finish({ content: `${body}${suffix}${note}`, isError: false });
    });
  });
}
