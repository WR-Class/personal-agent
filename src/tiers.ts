/**
 * Named permission tiers (D22, D26, D32, D48).
 *
 * A tier is a name for a whole posture, so that a person choosing one is
 * choosing a coherent set of answers rather than assembling them by hand. The
 * names exist only now that the semantics behind them exist: the capability set
 * decides what exists, the rule table decides what is asked, and path
 * confinement and the write budget are invariants that no tier may touch.
 *
 * Two rules from the earlier design work are enforced here rather than trusted:
 *
 * 1. A tier may never widen an invariant. Path confinement and the capability
 *    set are not expressible as rules, so no tier can reach them — this module
 *    can only choose among permission decisions, which is the point.
 * 2. The permissive tier requires an explicit recorded choice. It is not
 *    reachable through a permission label, and `resolveTier` refuses to fall
 *    back to it when a name is unknown. Refusing to *guess* full access is what
 *    keeps a stranger's default safe.
 *
 * The middle tier (D48) exists because the default asked about every single
 * write, which was measured to be more interruption than the mature products
 * impose. goose's `SmartApprove` is the reference: it stops asking when the
 * request is one it already knows to be harmless, and asks otherwise.
 *
 * What "harmless" means here is deliberately narrower than goose's, and the
 * difference is worth stating because it is the interesting part of the design.
 * goose has no way to know whether an arbitrary MCP tool is read-only, so layer 4
 * of its inspection asks the *model* to judge, and any failure of that call
 * (no provider, an error, an unparseable reply) falls back to asking — see
 * `permission_judge.rs` 179–185, which returns an empty set on every failure
 * path. That is fail-closed and correct for a system whose tools arrive from
 * outside.
 *
 * This project has no MCP and no third-party tools: every tool is built here, so
 * whether one writes is a fact in this codebase rather than an inference. Asking
 * a model to guess it would take a known fact and turn it into a guess, adding a
 * round trip and an unpredictable failure mode to buy nothing. (The same reason
 * an earlier round refused `chars/4` token estimates: prefer "not measured" to a
 * number that can be wrong in both directions.) So layer 4 is not adopted, and
 * the middle tier decides from `READ_ONLY_TOOLS` — the same list the tiers and
 * the rule table already read.
 *
 * What this tier therefore cannot do: stop asking about a *command*. Whether
 * `run_command` is harmless depends on the command, and the tool makes no promise
 * about it, so it keeps asking. That is a real limit, not an oversight.
 */

import { RULE_TIERS } from "./rule-table.ts";
import type { Decision, Rule } from "./rule-table.ts";
import { APPROVAL_TOOLS, DEFAULT_RULES } from "./file-policy.ts";
import { READ_ONLY_TOOLS, WRITE_TOOLS } from "./write-tools.ts";

export { READ_ONLY_TOOLS, WRITE_TOOLS } from "./write-tools.ts";

export interface Tier {
  readonly name: string;
  readonly summary: string;
  /** Tools this tier does not offer at all. Absence, not denial. */
  readonly tools: readonly string[];
  readonly rules: readonly Rule[];
  /**
   * True when the tier removes a boundary. Selecting one of these is an
   * operator decision that has to be recorded, not a default.
   */
  readonly removesBoundary?: boolean;
}

function denyAllWrites(reason: string): Rule[] {
  return [
    // The allow must rank *above* the wildcard deny, or the deny swallows reads
    // too and the tier becomes "read nothing" rather than "read only". Ordering
    // is the mechanism here, so the numbers are load-bearing, not cosmetic.
    // One allow per read-only tool: a wildcard allow would also admit the write
    // tools, and this tier's whole point is that they are absent.
    ...READ_ONLY_TOOLS.map((tool, index) => ({
      id: `read-only.allow-${tool}`,
      tool,
      decision: "allow" as Decision,
      tier: RULE_TIERS.USER,
      priority: 900 - index,
    })),
    {
      id: "read-only.deny-writes",
      tool: "*",
      decision: "deny",
      tier: RULE_TIERS.USER,
      priority: 800,
      reason,
    },
  ];
}

/**
 * The middle tier's rules (D48).
 *
 * It stops asking about reads and keeps asking about writes. That is the whole
 * intent, and it is worth being precise about how much it buys, because an
 * earlier draft of this file claimed more than the code delivers and its own test
 * caught it.
 *
 * Measured while building it: every `approveExact` call site in `tools.ts` is on
 * a write tool — `run_command`, `job_kill`, and the six file tools. No read tool
 * asks at all. So under `workspace-write` the interruptions an operator actually
 * sees are already writes, and a tier that merely re-states the read/write split
 * decides *exactly* what `workspace-write` decides. That is a synonym, not a
 * posture, and a test in `tiers.test.ts` now fails if the two ever collapse into
 * one another again.
 *
 * What genuinely differs is `run_command`. It is classified as a writing tool
 * because it can write; but a command is very often only a read — `git status`,
 * `ls`, `grep`. goose resolves this by asking the model to judge whether a request
 * is read-only, which this project declines to do (see the header: the fact is
 * known here, not guessed). The middle tier therefore takes the narrower, honest
 * position: a command that *only reads* does not need approval, and that is
 * decided by whether the command writes, not by asking anyone.
 *
 * The judgement is deliberately conservative: anything not recognised as a pure
 * read still asks. A miss costs an interruption, which is the failure this design
 * can afford; a false pass would be a write nobody approved, which it cannot.
 */
function askBeforeWriting(): Rule[] {
  return [
    // `run_command` needs *two* rules, and the first draft had only one, which
    // its own test caught: a single conditional allow left every command that did
    // not match the predicate falling through to the wildcard deny, so an
    // unmatched command was refused outright instead of being asked about. The
    // unconditional `approve` below is what makes the conditional allow a
    // *convenience* rather than the only path through.
    {
      id: "ask-before-writing.read-only-command",
      tool: "run_command",
      decision: "allow",
      tier: RULE_TIERS.WORKSPACE,
      priority: 80,
      when: (args) => isReadOnlyCommand(args),
      reason: "只读命令：本档不询问",
    },
    {
      id: "ask-before-writing.run_command",
      tool: "run_command",
      decision: "approve",
      tier: RULE_TIERS.WORKSPACE,
      priority: 10,
    },
    // Every other write keeps asking. Listed explicitly rather than inherited, so
    // a change to `DEFAULT_RULES` cannot silently quieten the posture an operator
    // chose by name.
    ...APPROVAL_TOOLS.filter((tool) => tool !== "run_command").map(
      (tool): Rule => ({
        id: `ask-before-writing.${tool}`,
        tool,
        decision: "approve",
        tier: RULE_TIERS.WORKSPACE,
        priority: 10,
      }),
    ),
    // Reads are allowed, one rule per tool, for the reason recorded in
    // `file-policy.ts`: a wildcard would also admit the write tools.
    ...READ_ONLY_TOOLS.map(
      (tool, index): Rule => ({
        id: `ask-before-writing.read-${tool}`,
        tool,
        decision: "allow",
        tier: RULE_TIERS.WORKSPACE,
        priority: 50 - index,
      }),
    ),
  ];
}

/**
 * Commands allowed to run without being asked about.
 *
 * This is a whitelist and is meant to be a small one. It is not a safety
 * mechanism — the safety is that everything unrecognised still asks — so a miss
 * here loses a convenience and nothing else. That is the same shape as crush's
 * unasked-command list (`internal/agent/tools/safe.go`), and the same reason its
 * gaps are not security holes: the fallback is to ask, not to allow.
 *
 * **The admission criterion.** A tool belongs here only if *neither its own flags
 * nor any project-local configuration it reads* can cause it to run another
 * program. "Looks like a read" is not the test, and trusting it produced a real
 * hole that was reproduced rather than reasoned about: `git status` was on this
 * list, and in a repository whose `.git/config` sets `core.fsmonitor` to a
 * command, running `git status` executed that command and wrote a file. The
 * operator's own posture had classified it as a read and not asked.
 *
 * That is the failure this project has said it cannot accept — a miss costs one
 * interruption, a false pass is a write nobody approved — so the entries below
 * were re-checked against the criterion and three came off:
 *
 * - `git` — reads `.git/config`, which can run code through `core.fsmonitor`
 *   (on `status`), `core.pager` (on `log`/`diff`/`show`) and `diff.*.textconv`
 *   (on `diff`). There is no environment variable that disables repository-level
 *   config: `GIT_CONFIG_NOSYSTEM` only covers the system file. Overriding the
 *   dangerous keys one by one with `git -c key=` would mean enumerating them,
 *   which is the "list the dangerous things" shape this project has already
 *   failed with twice. Restoring git needs D26 (repository config must not
 *   escalate its own privileges) rather than a longer list here.
 * - `rg` — ripgrep's `--pre` flag runs a preprocessor command. Not verified on
 *   this machine, which has no ripgrep installed; it is excluded because a tool
 *   whose flags cannot all be vouched for does not belong on a list whose entire
 *   safety argument is that each entry was vouched for.
 * - `npm ls` / `list` — npm reads the project's own `.npmrc`, and whether that
 *   can influence execution was not verified. Only the exact version query stays.
 *
 * Entries that were checked and *can* write, kept out for that reason:
 *
 * - `date` and `time` — both *set* the system clock when given an argument
 *   (`time 10:00`), so they are not reads at all.
 * - `sort` — `-o file` / `--output=file` writes a file.
 * - `uniq` — takes an optional second positional argument that is an output file.
 * - `echo` — harmless alone, but its entire purpose is to produce output that is
 *   normally redirected; it costs one interruption and is left out on principle.
 * - `find` is included, but only with its executing flags refused (below).
 */
const PURE_READ_COMMANDS: ReadonlySet<string> = new Set([
  // Listing and locating.
  "dir", "ls", "pwd", "cd", "which", "where", "whoami",
  // Reading file contents.
  "cat", "type", "head", "tail", "wc",
  // Searching. `rg` is absent: see the admission criterion above.
  "grep", "findstr",
]);

/**
 * `find` reads by default but deletes and executes on request. These flags turn
 * it into a writing command, so their presence ends the read-only judgement.
 */
const FIND_WRITING_FLAGS: ReadonlySet<string> = new Set([
  "-delete", "-exec", "-execdir", "-ok", "-okdir", "-fls", "-fprint", "-fprintf",
]);

/**
 * Interpreters allowed only in their exact version-query form.
 *
 * These are the sharpest case in the file, because the same executable is either
 * harmless or unrestricted depending on the next word: `node --version` prints a
 * number and `node -e "..."` can do anything at all. So the match is on the exact
 * token sequence, not on a prefix or a search — any extra argument means this
 * project no longer knows what will run, and the answer becomes "ask".
 */
const VERSION_ONLY_FLAGS: ReadonlySet<string> = new Set(["-v", "-V", "--version"]);

/** Characters that can turn a reading command into a writing one. */
const SHELL_CHAINING = /[>|&;\n\r]/;

/**
 * Whether a command only reads, so the middle tier need not ask about it.
 *
 * Every branch here ends in `false` unless something positively identified the
 * command as a read. That direction matters more than the contents of any list:
 * an unrecognised command costs the operator one interruption, while a
 * misidentified one is a write nobody approved.
 */
function isReadOnlyCommand(args: Record<string, unknown>): boolean {
  const raw = args.command;
  if (typeof raw !== "string") return false;
  const command = raw.trim();
  if (command === "") return false;
  // Redirection, pipes and chaining all mean the command is doing more than
  // reading, whatever it starts with. `git status > /etc/passwd` and
  // `ls & rm -rf x` both begin with a verb on the read list.
  if (SHELL_CHAINING.test(command)) return false;

  // Every comparison below is made against a lowercased copy. Windows does not
  // distinguish `GIT STATUS` from `git status`, so a judgement that did would
  // answer differently for the same command depending on how it was typed. Only
  // this copy is folded: the command the shell actually receives is untouched,
  // which matters because a filename in it may be case-sensitive.
  const [head, ...rest] = command
    .split(/\s+/)
    .filter((token) => token !== "")
    .map((token) => token.toLowerCase());
  if (head === undefined) return false;
  // Strip the Windows suffixes so `npm.cmd` and `git.exe` match their entries.
  const name = head.replace(/\.(exe|cmd|bat|com)$/, "");

  if (PURE_READ_COMMANDS.has(name)) return true;

  if (name === "find") {
    // Kept out of PURE_READ_COMMANDS on purpose: `find` reads by default but
    // deletes and executes on request, so it needs this check and the set does
    // not express one.
    return !rest.some((token) => FIND_WRITING_FLAGS.has(token));
  }

  // No branch for `git`, on purpose: it reads repository configuration that can
  // run code, so it falls through to "ask" like anything else unrecognised. See
  // the admission criterion above before adding a special case for it.

  if (name === "npm" || name === "pnpm" || name === "yarn") {
    // Only the exact version query. `npm test`, `npm run` and `npm install`
    // execute whatever the project's own scripts say, which is arbitrary code;
    // `npm ls` was removed as well because npm reads the project's `.npmrc` and
    // whether that can influence execution was never verified.
    return rest.length === 1 && VERSION_ONLY_FLAGS.has(rest[0]!);
  }

  if (name === "go") {
    const [subcommand] = rest;
    // `go env -w` writes configuration, so only the bare forms are reads.
    if (subcommand === "version" && rest.length === 1) return true;
    return subcommand === "env" && rest.length === 1;
  }

  if (name === "cargo") {
    return rest.length === 1 && VERSION_ONLY_FLAGS.has(rest[0]!);
  }

  // Interpreters: exactly `node --version` and nothing else. A script path, an
  // `-e`, or any additional flag all mean this project cannot see what will run.
  if (
    name === "node" || name === "python" || name === "python3" ||
    name === "java" || name === "tsc" || name === "dotnet"
  ) {
    return rest.length === 1 && VERSION_ONLY_FLAGS.has(rest[0]!);
  }

  return false;
}

export const TIERS: readonly Tier[] = [
  {
    name: "read-only",
    summary: "读取与检索；写入类工具在本会话中不存在",
    tools: READ_ONLY_TOOLS,
    rules: denyAllWrites("read-only tier: writing is not available in this session"),
  },
  {
    name: "ask-before-writing",
    summary: "读取不询问；写入类工具仍然逐次批准",
    tools: [...READ_ONLY_TOOLS, ...WRITE_TOOLS],
    rules: askBeforeWriting(),
  },
  {
    name: "workspace-write",
    summary: "在工作区内读写；写入仍需逐次批准",
    tools: [...READ_ONLY_TOOLS, ...WRITE_TOOLS],
    rules: DEFAULT_RULES,
  },
  {
    name: "full-access",
    summary: "移除写入门禁；路径收敛、写预算与审计仍然生效",
    tools: [...READ_ONLY_TOOLS, ...WRITE_TOOLS],
    removesBoundary: true,
    rules: [
      { id: "full-access.allow-all", tool: "*", decision: "allow" as Decision, tier: RULE_TIERS.ADMIN, priority: 0 },
    ],
  },
];

/** The tier used when nothing was chosen. Safe for a stranger's first run. */
export const DEFAULT_TIER = "workspace-write";

export function findTier(name: string): Tier | undefined {
  return TIERS.find((tier) => tier.name === name);
}

/**
 * Resolve a tier name, refusing to guess.
 *
 * An unknown name is an error rather than a fallback: silently substituting a
 * tier would mean a typo in a config file changes the posture without anyone
 * being told, and falling back to the permissive one would hand out full access
 * on a misspelling.
 */
export function resolveTier(name: string | undefined): Tier {
  if (name === undefined || name === "") return findTier(DEFAULT_TIER)!;
  const tier = findTier(name);
  if (!tier) {
    throw new Error(`unknown permission tier: ${name} (known: ${TIERS.map((t) => t.name).join(", ")})`);
  }
  return tier;
}
