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

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { findTier } from "../src/tiers.ts";
import { decide } from "../src/rule-table.ts";

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
    "rg pattern",
    "find . -name '*.ts'",
    // git, by subcommand rather than by first word.
    "git status",
    "git log --oneline",
    "git diff HEAD~1",
    "git show",
    "git branch",
    "git rev-parse HEAD",
    "git ls-files",
    // Interpreters, only in their version-query form.
    "node --version",
    "node -v",
    "python --version",
    "go version",
    "go env",
    "cargo -V",
    "npm --version",
    "npm ls",
    // Normalisation: case, padding and the Windows suffixes.
    "  git status  ",
    "GIT STATUS",
    "Git Log --oneline",
    "npm.cmd ls",
    "git.exe status",
  ]) {
    it(`does not ask about ${JSON.stringify(command)}`, () => {
      assert.equal(decisionFor(command), "allow");
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

    // CHANGED-CODE: git subcommands that change state.
    ["git commit -m x", "`git commit` writes history"],
    ["git add .", "`git add` stages changes"],
    ["git reset --hard", "`git reset --hard` destroys working-tree changes"],
    ["git checkout -b feature", "`git checkout` switches and can create"],
    ["git clean -fd", "`git clean` deletes untracked files"],
    ["git branch new-name", "`git branch <name>` creates a branch, with no flag to scan for"],
    ["git branch -D old", "`git branch -D` deletes a branch"],
    ["git config user.name x", "`git config` with a value writes configuration"],
    ["git stash", "`git stash` changes the working tree"],
    ["git push", "`git push` changes the remote"],
    ["git diff --output=out.txt", "`--output` makes a reading subcommand write a file"],

    // CHANGED-CODE: interpreters, where the first word says nothing at all.
    ["node -e \"require('fs').writeFileSync('x','y')\"", "`node -e` runs arbitrary code"],
    ["node build.js", "a script can do anything"],
    ["node --version --experimental-loader=x", "an extra flag means this project no longer knows what will run"],
    ["python -c \"open('x','w')\"", "`python -c` runs arbitrary code"],
    ["python script.py", "a script can do anything"],
    ["go env -w GOFLAGS=-x", "`go env -w` writes configuration"],
    ["go build", "`go build` writes a binary"],
    ["cargo build", "`cargo build` writes artifacts"],

    // CHANGED-CODE: package managers, where the subcommand is the whole story.
    ["npm test", "`npm test` runs whatever the project's own script says"],
    ["npm run build", "`npm run` runs arbitrary project scripts"],
    ["npm install", "`npm install` writes node_modules and runs lifecycle scripts"],
    ["npx some-tool", "`npx` fetches and runs arbitrary code"],

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
    assert.equal(decide(findTier("read-only")!.rules, "run_command", { command: "git status" }).decision, "deny");
  });

  it("keeps the default asking even about a read-only command", () => {
    // `workspace-write` asks about every command, including `git status`. This is
    // the behaviour the middle tier exists to relieve, and it must not have been
    // changed in the process — otherwise the new tier would have quietly widened
    // the posture an existing operator had chosen.
    assert.equal(
      decide(findTier("workspace-write")!.rules, "run_command", { command: "git status" }).decision,
      "approve",
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
