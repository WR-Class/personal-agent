/**
 * The documentation-debt gate (D108).
 *
 * The rule this enforces is the operator's, and it was written down long before the
 * gate was: code and its record land together, and documentation debt does not
 * cross a round. For thirteen rounds the only thing enforcing it was my
 * remembering it, and it failed twice in two rounds — `0308148` and `9834773` each
 * changed `src/` with no `STATUS.md` batch, and in both cases it was the operator
 * who noticed, not a check.
 *
 * That is the same shape as every other assertion-instead-of-a-check failure this
 * project has catalogued: an assertion that is wrong costs nothing, while a check
 * that is wrong goes red. `citation-gate.test.ts` caught a stale pointer on its
 * first run that roughly thirty doc-embedded line numbers had hidden. This file is
 * the same move applied to the debt rule.
 *
 * ⚠️ What it enforces is deliberately weaker than "one commit", and the weakness is
 * the point rather than an oversight. Measured over all 127 commits: 51 changed
 * both, 10 changed `src/` alone, 66 touched neither. A gate demanding one commit
 * would be red on arrival and would need those 10 frozen into an exemption list —
 * and D103 is the record of what a stale exemption list costs, since D80's list had
 * rotted to the point where its own modal pipe count no longer matched the header.
 * So the rule here is "no unpaid debt at HEAD": walk back from HEAD and stop at the
 * first commit that touched `docs/STATUS.md`; every commit before that point which
 * touched `src/` is debt still outstanding.
 *
 * The consequence, stated plainly: paying the batch in the *next* commit passes this
 * gate. What it cannot pass is a round that ends with the debt unpaid, which is the
 * failure that actually happened twice.
 *
 * ⚠️ The first version of this file passed 2/2 while parsing nothing. It split
 * commits on a `\0\0` sequence that `git log -z --name-only` never emits, so every
 * record failed the hash check, was skipped, and the debt list came back empty —
 * green for the wrong reason, which is worse than red. Two things changed because of
 * that: the format is now line-based with an explicit marker rather than inferred
 * from NUL placement, and the second test below feeds this parser a synthetic log so
 * the arithmetic is checked independently of whatever git happens to print. A gate
 * whose only exercise is a live repository cannot tell "no debt" from "parsed
 * nothing".
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

/** Marks a commit header line. Chosen so no real path or subject can collide. */
const MARKER = "@@DSH-DOC-DEBT-COMMIT@@";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

function gitLog(): string | null {
  try {
    return execFileSync("git", ["log", `--format=${MARKER}%H%x20%s`, "--name-only", "--no-renames"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
      maxBuffer: 64 * 1024 * 1024,
    });
  }
  catch {
    // Not a git checkout, or git is absent. An environment fact, not a passing
    // check, so it is reported as a skip rather than as green.
    return null;
  }
}

interface Outstanding {
  readonly hash: string;
  readonly subject: string;
}

/**
 * Commits touching `src/` that sit above the most recent commit touching
 * `docs/STATUS.md`. Empty means the record is paid up to date.
 */
export function outstandingDebt(log: string): Outstanding[] {
  const debt: Outstanding[] = [];
  let hash: string | null = null;
  let subject = "";
  let paths: string[] = [];

  const flush = (): boolean => {
    if (hash === null) return false;
    // true means "stop walking": the record is paid as of this commit.
    const paid = paths.includes("docs/STATUS.md");
    if (!paid && paths.some((path) => path.startsWith("src/"))) debt.push({ hash: hash.slice(0, 7), subject });
    hash = null;
    paths = [];
    return paid;
  };

  for (const rawLine of log.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith(MARKER)) {
      if (flush()) break;
      const rest = line.slice(MARKER.length).trimStart();
      const space = rest.indexOf(" ");
      const candidate = space === -1 ? rest : rest.slice(0, space);
      // A malformed header is skipped rather than counted, so stray output cannot
      // manufacture debt.
      if (!/^[0-9a-f]{40}$/.test(candidate)) continue;
      hash = candidate;
      subject = space === -1 ? "" : rest.slice(space + 1);
      continue;
    }
    if (line === "") continue;
    if (hash !== null) paths.push(line);
  }
  flush();
  return debt;
}

describe("documentation debt", () => {
  it("has no commit touching src/ above the last commit touching docs/STATUS.md", (t) => {
    const log = gitLog();
    if (log === null) {
      t.skip("not a git checkout, or git is unavailable — the gate could not run, which is not a pass");
      return;
    }
    // ⚠️ Guard against the exact false green this file was rewritten for: if the
    // parser saw no commits at all, an empty debt list proves nothing.
    assert.ok(log.includes(MARKER), "git log 里没有提交标记 —— 解析器什么都没看到，绿灯无意义");
    assert.match(log, new RegExp(`${MARKER}[0-9a-f]{40}`), "标记后面没有合法的 40 位哈希 —— 格式假设与 git 实际输出不符");
    const debt = outstandingDebt(log);
    assert.deepEqual(
      debt,
      [],
      `${debt.length} 个提交改了 src/ 却没有配套的 STATUS.md 批次：`
      + debt.map((item) => `${item.hash} ${item.subject}`).join("; ")
      + "。允许的修法只有一种 —— 把欠的批次补上。"
      + "不允许把这条断言放宽、把这个闸门删掉、或把提交哈希加进某个豁免名单："
      + "豁免名单会腐烂，D80 那份名单烂到自己的众数竖线数都对不上表头（见 table-gate.test.ts）。",
    );
  });

  it("parses a synthetic log, so the arithmetic does not depend on a live repo", () => {
    const header = (hash: string, subject: string) => `${MARKER}${hash} ${subject}`;
    const a = "a".repeat(40);
    const b = "b".repeat(40);
    const c = "c".repeat(40);
    const d = "d".repeat(40);

    // Paid: the src/ commit sits below a STATUS.md commit.
    assert.deepEqual(outstandingDebt([
      header(a, "docs batch"), "docs/STATUS.md", "",
      header(b, "code"), "src/gene.ts", "",
    ].join("\n")), [], "已还清的历史不算欠账");

    // Unpaid: the src/ commit is above the last STATUS.md commit.
    const unpaid = outstandingDebt([
      header(a, "code with no batch"), "src/gene.ts", "test/gene.test.ts", "",
      header(b, "docs batch"), "docs/STATUS.md", "",
    ].join("\n"));
    assert.equal(unpaid.length, 1);
    assert.equal(unpaid[0]!.hash, a.slice(0, 7));
    assert.equal(unpaid[0]!.subject, "code with no batch");

    // Two unpaid commits accumulate in order; docs-only and test-only commits are
    // not debt, and a commit touching another doc alongside src/ still is.
    const two = outstandingDebt([
      header(a, "code one"), "src/a.ts", "",
      header(b, "tests only"), "test/b.test.ts", "",
      header(c, "code two"), "src/c.ts", "docs/CODE_MAP.md", "",
      header(d, "docs batch"), "docs/STATUS.md", "",
    ].join("\n"));
    assert.deepEqual(two.map((item) => item.hash), [a.slice(0, 7), c.slice(0, 7)]);

    // A malformed header is skipped rather than counted.
    assert.deepEqual(outstandingDebt([
      `${MARKER}not-a-hash junk`, "src/x.ts", "",
      header(a, "docs batch"), "docs/STATUS.md", "",
    ].join("\n")), []);

    // No STATUS.md commit anywhere in the log: every src/ commit is debt, and the
    // walk reaches the root rather than stopping early.
    const root = outstandingDebt([
      header(a, "code one"), "src/a.ts", "",
      header(b, "code two"), "src/b.ts", "",
    ].join("\n"));
    assert.equal(root.length, 2, "日志里没有任何 STATUS.md 提交时，所有 src/ 提交都是欠账");

    // CRLF, as git emits on Windows.
    assert.equal(outstandingDebt([
      header(a, "code"), "src/a.ts", "",
      header(b, "docs batch"), "docs/STATUS.md", "",
    ].join("\r\n")).length, 1, "Windows 的 CRLF 行尾必须照样解析");
  });
});
