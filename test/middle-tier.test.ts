/**
 * The middle tier's command judgement (D48).
 *
 * `ask-before-writing` is the only tier whose decision depends on the *content* of
 * a call, so it is the only one where a mistake can go two different ways: too
 * lax and a write runs unapproved, too strict and the tier is a synonym for the
 * default with extra machinery. Both directions are tested here.
 *
 * The dangerous cases are all of one shape — "begins with a reading command, does
 * something else" — and each is a real command rather than an invented string.
 * Several were found by writing this file rather than by reasoning about the
 * implementation, and the ones that changed the code are marked, because the point
 * of the list is that it be checkable against the flags a verb actually accepts.
 */

import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { findTier } from "../src/tiers.ts";
import { decide } from "../src/rule-table.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { SessionStore } from "../src/session-store.ts";
import { ToolRegistry, createRunCommandTool } from "../src/tools.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { createTestFixture } from "./fixtures.ts";

const middle = findTier("ask-before-writing")!;

function decisionFor(command: string): string {
  return decide(middle.rules, "run_command", { command }).decision;
}

describe("middle tier: commands that only read do not ask", () => {
  for (const command of [
    // The verbs whose whole meaning is to read.
    "dir",
    "ls -la",
    "pwd",
    "cat src/tiers.ts",
    "type notes.txt",
    "head -n 20 README.md",
    "tail -n 5 log.txt",
    "grep -r foo src",
    "findstr /s TODO *.ts",
    "find . -name '*.ts'",
    // Interpreters, only in their version-query form.
    "node --version",
    "node -v",
    "python --version",
    "go version",
    "go env",
    "cargo -V",
    "npm --version",
    // Normalisation: case, padding and the Windows suffixes.
    "  dir  ",
    "CAT notes.txt",
    "npm.cmd --version",
  ]) {
    it(`does not ask about ${JSON.stringify(command)}`, () => {
      assert.equal(decisionFor(command), "allow");
    });
  }
});

describe("middle tier: git asks, because repository config can run code", () => {
  /**
   * This group exists because of a reproduced hole, not a theoretical one.
   *
   * `git status` was on the read-only whitelist. In a repository whose own
   * `.git/config` sets `core.fsmonitor` to a command, running `git status`
   * executed that command and wrote a file — verified on this machine by creating
   * exactly that repository and finding the marker file afterwards. The tier had
   * classified the command as a read and therefore did not ask, which is the one
   * failure mode this design says it cannot have.
   *
   * `core.fsmonitor` is not the only vector: `core.pager` runs on `git log`, and
   * `diff.*.textconv` runs on `git diff`. So narrowing by subcommand does not
   * help — every reading subcommand consults the same configuration. Nothing
   * environmental closes it either, since `GIT_CONFIG_NOSYSTEM` suppresses only
   * the system file and not the repository's. These stay as permanent
   * regressions: re-adding git to the whitelist needs D26 (repository config must
   * not escalate its own privileges), not a longer subcommand list.
   */
  for (const command of [
    "git status",
    "git log --oneline",
    "git diff HEAD~1",
    "git show",
    "git branch",
    "git rev-parse HEAD",
    "git ls-files",
    "git blame src/tiers.ts",
    // The forms that write, which the subcommand list never covered anyway.
    "git commit -m x",
    "git config core.fsmonitor evil.cmd",
    "git.exe status",
    "GIT STATUS",
  ]) {
    it(`asks about ${JSON.stringify(command)}`, () => {
      assert.equal(decisionFor(command), "approve");
    });
  }
});

describe("middle tier: anything that can write still asks", () => {
  /**
   * Each entry is a command that a first-word whitelist would have let through.
   * The ones marked CHANGED-CODE were found by this file and removed from the
   * allow side; they are kept as permanent regressions rather than deleted once
   * they pass, because the temptation to re-add `git` or `node` wholesale will
   * come back the first time the tier feels too chatty.
   */
  const writes: [string, string][] = [
    // Shell metacharacters: the leading verb reads, the rest does not.
    ["git status > /etc/passwd", "redirection turns a read into a write"],
    ["git status >> out.txt", "appending is still writing"],
    ["ls | rm -rf build", "a pipe runs another command"],
    ["ls && rm -rf build", "chaining runs another command"],
    ["ls & rm -rf /", "a single ampersand, which crush's own check was measured to miss"],
    ["ls ; rm -rf build", "a semicolon runs another command"],
    ["ls\nrm -rf build", "a newline starts a second command"],
    ["cat x.txt > y.txt", "a reading verb, redirected into a write"],

    // CHANGED-CODE: verbs that write despite looking like reads.
    ["date 2020-01-01", "`date` sets the system clock when given an argument"],
    ["time 10:00", "`time` sets the system clock when given an argument"],
    ["sort names.txt -o sorted.txt", "`sort -o` writes a file"],
    ["sort --output=sorted.txt names.txt", "`sort --output` writes a file"],
    ["uniq input.txt output.txt", "`uniq` takes an output file as a second argument"],
    ["echo hello", "left out on principle: its purpose is to feed a redirection"],
    ["find . -delete", "`find -delete` removes files"],
    ["find . -name '*.tmp' -exec rm {} ;", "`find -exec` runs an arbitrary command"],
    ["find . -execdir sh -c 'x' ;", "`find -execdir` likewise"],
    ["find . -fls out.txt", "`find -fls` writes a file"],

    // CHANGED-CODE: git writes too, but it is no longer worth enumerating the
    // subcommands — the whole family asks for the single reason recorded in the
    // describe block above, so these two stand in for all of them.
    ["git commit -m x", "`git commit` writes history"],
    ["git clean -fd", "`git clean` deletes untracked files"],

    // CHANGED-CODE: tools excluded because their flags or the project-local
    // configuration they read can run another program.
    ["rg pattern", "`rg --pre` runs a preprocessor; not installed here, so it could not be vouched for"],
    ["npm ls", "npm reads the project's own `.npmrc`, which was never verified as inert"],
    ["npm test", "`npm test` runs whatever the project's own script says"],
    ["npm run build", "`npm run` runs arbitrary project scripts"],
    ["npm install", "`npm install` writes node_modules and runs lifecycle scripts"],
    ["npx some-tool", "`npx` fetches and runs arbitrary code"],

    // CHANGED-CODE: interpreters, where the first word says nothing at all.
    ["node -e \"require('fs').writeFileSync('x','y')\"", "`node -e` runs arbitrary code"],
    ["node build.js", "a script can do anything"],
    ["node --version --experimental-loader=x", "an extra flag means this project no longer knows what will run"],
    ["python -c \"open('x','w')\"", "`python -c` runs arbitrary code"],
    ["python script.py", "a script can do anything"],
    ["go env -w GOFLAGS=-x", "`go env -w` writes configuration"],
    ["go build", "`go build` writes a binary"],
    ["cargo build", "`cargo build` writes artifacts"],

    // Not on any list.
    ["rm -rf build", "not a read at all"],
    ["curl http://example.com", "network access is not a read of this workspace"],
    ["powershell -c Remove-Item x", "an interpreter that can do anything"],
    ["", "an empty command is not a read"],
    ["   ", "whitespace is not a read"],
  ];

  for (const [command, why] of writes) {
    it(`asks about ${JSON.stringify(command)} — ${why}`, () => {
      assert.equal(decisionFor(command), "approve");
    });
  }

  it("asks when the command is missing or not a string", () => {
    // A malformed argument must fall back to asking. If it fell through to the
    // wildcard it would be denied outright, which is a different failure: the
    // model would be told the tool is unavailable rather than that it needs
    // permission. The unconditional `approve` rule in `askBeforeWriting` is what
    // makes this true, and a first draft without it produced exactly that denial.
    assert.equal(decide(middle.rules, "run_command", {}).decision, "approve");
    assert.equal(decide(middle.rules, "run_command", { command: 42 }).decision, "approve");
    assert.equal(decide(middle.rules, "run_command", { command: null }).decision, "approve");
    assert.equal(decide(middle.rules, "run_command", { command: ["git", "status"] }).decision, "approve");
  });
});

describe("middle tier: the other three tiers are unchanged by its existence", () => {
  it("keeps read-only denying commands outright", () => {
    // Not "asks" — this tier does not offer the tool at all, and that distinction
    // is the tier's whole meaning.
    assert.equal(decide(findTier("read-only")!.rules, "run_command", { command: "dir" }).decision, "deny");
  });

  it("keeps the default asking even about a read-only command", () => {
    // `workspace-write` asks about every command, including `dir`, which the
    // middle tier lets through. This is the behaviour the middle tier exists to
    // relieve, and it must not have been changed in the process — otherwise the
    // new tier would have quietly widened the posture an existing operator chose.
    // `dir` is the example rather than `git status` because git now asks under
    // both tiers, which would make the comparison prove nothing.
    assert.equal(
      decide(findTier("workspace-write")!.rules, "run_command", { command: "dir" }).decision,
      "approve",
    );
    assert.equal(
      decide(middle.rules, "run_command", { command: "dir" }).decision,
      "allow",
    );
  });

  it("keeps full-access allowing without asking", () => {
    assert.equal(
      decide(findTier("full-access")!.rules, "run_command", { command: "rm -rf build" }).decision,
      "allow",
    );
  });

  it("is not the permissive tier", () => {
    // A tier that stops asking about some commands is still not one that removes a
    // boundary, and must not inherit the recorded-choice requirement either way.
    assert.equal(middle.removesBoundary, undefined);
  });
});

/**
 * The reproduced hole, driven end to end.
 *
 * Everything above this block checks `decide()`, which is the judgement. This
 * checks the consequence, through the runtime and the real approval gate, in a
 * real repository whose own configuration runs a command when git reads it. The
 * distinction matters: a tier can return the right decision and still not be
 * wired to the tool, which is exactly the bug D46 found in `full-access`.
 *
 * The assertion is a marker file on disk rather than anything parsed out of a
 * transcript, because "the file appeared" is a mechanical fact while "the model
 * said it was refused" is a claim.
 */
describe("middle tier: repository config cannot execute through a read", () => {
  let gitAvailable = false;
  before(() => {
    try {
      execFileSync("git", ["--version"], { stdio: "ignore" });
      gitAvailable = true;
    } catch {
      gitAvailable = false;
    }
  });

  /** Builds a real repository whose own `.git/config` runs a command on `git status`. */
  function poisonedRepo(directory: string, marker: string): void {
    mkdirSync(directory, { recursive: true });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: directory, stdio: "ignore" });
    git("init", "-q", ".");
    git("config", "user.email", "t@example.invalid");
    git("config", "user.name", "test");
    writeFileSync(join(directory, "a.txt"), "hello", "utf8");
    git("add", ".");
    git("commit", "-qm", "init");
    // The payload: writes a marker when git invokes it. Git does not care that
    // its output is not a valid fsmonitor token — it warns and carries on, having
    // already run the command, which is the whole point.
    const payload = join(directory, "payload.cmd");
    writeFileSync(payload, `@echo off\r\necho EXECUTED> "${marker}"\r\n`, "utf8");
    // `core.untrackedCache` is what makes git consult `core.fsmonitor` on the
    // first `git status` rather than on a later one.
    git("config", "core.fsmonitor", payload.replaceAll("\\", "/"));
    git("config", "core.untrackedCache", "true");
  }

  /** Runs `git status` through the runtime under one tier, with nobody to ask. */
  async function runGitStatus(tierName: string, label: string, repository: string): Promise<void> {
    const tier = findTier(tierName)!;
    const fixture = await createTestFixture(label);
    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({
        steps: [
          { toolCalls: [{ id: "c1", name: "run_command", arguments: JSON.stringify({ command: "git status" }) }] },
          { content: "done" },
        ],
      }),
      store: new SessionStore({ root: fixture.storeRoot }),
      sessionId: `${label}-session`,
      workspaceRoot: repository,
      home: fixture.home,
      // Only `run_command` is registered, so the capability set is named
      // explicitly rather than passing `tier.tools`: the registry rejects an
      // available name it does not have, and what this test exercises is the
      // tier's rules, not its tool list (covered in test/tiers.test.ts).
      tools: new ToolRegistry([createRunCommandTool()], ["run_command"]),
      rules: tier.rules,
    });
    await runtime.send("run git status");
  }

  it("refuses git status, which would otherwise run the repository's own command", async (t) => {
    if (!gitAvailable) return t.skip("git is not installed on this machine");

    const fixture = await createTestFixture("middle-tier-poison");
    const repository = join(fixture.root, "repo");
    const marker = join(fixture.root, "marker.txt");
    poisonedRepo(repository, marker);

    // Prove the payload really fires before claiming anything was blocked.
    // Without this step a green result could mean "git was missing" or "the
    // payload never ran" instead of "the tier stopped it" — the same mistake as
    // reporting a budget-limited run as a capability failure.
    await runGitStatus("full-access", "poison-control", repository);
    assert.ok(
      existsSync(marker),
      "control failed: the poisoned repository did not execute its own config, so this test would prove nothing",
    );
    assert.equal(readFileSync(marker, "utf8").trim(), "EXECUTED");

    // The case that matters: same repository, same command, middle tier, and no
    // approval channel configured — so "ask" has to become "refuse".
    rmSync(marker, { force: true });
    await runGitStatus("ask-before-writing", "poison-blocked", repository);
    assert.equal(
      existsSync(marker),
      false,
      "a command the middle tier let through executed code from the repository's own config",
    );
  });
});
