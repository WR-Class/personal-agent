/**
 * The citation gate (D98 ⑤, finished in D99).
 *
 * The most frequent defect in this project's documentation is a pointer to a
 * source line that does not say what the document claims it says. Seven
 * confirmed instances: D89's `IMPLEMENTATION.md:117`, D90's "this is the
 * lesion", D91's `Agent-Reach` claim, D95's three, and D98's `runtime.ts:1070`
 * — which two committed rounds cited while one of them had already marked it
 * unverified. Marking a citation unverified does not stop the next round
 * reusing it, so the check has to be mechanical.
 *
 * ⚠️ Scope, deliberately narrow. Most quoted text in `docs/` is a Chinese
 * paraphrase of behaviour, not verbatim source. Requiring every quotation to
 * appear in the file would fail hundreds of legitimate sentences. What is
 * testable is the word 逐字 ("verbatim"): when a document says a passage is
 * verbatim from `file.ts:NNN`, that is a claim with a decidable answer. So this
 * gate checks only claims marked 逐字.
 *
 * ⚠️ Two calibrations this file's own first runs forced, both recorded so they
 * are not re-derived. Pairing is directional: taking every citation and every
 * quotation within 400 characters of a 逐字 marker produced 157 failures out of
 * 160, because these documents quote *each other* — D98 quotes D96's sentence
 * in the same window where it cites `runtime.ts:1147`, so the gate demanded
 * that D96's Chinese prose appear in the source. What the docs actually write
 * is `逐字 … \`file.ts:NNN\` … *"passage"*`, in that order, close together, so
 * each quotation looks BACKWARD for its citation and requires 逐字 between
 * them. And a citation is usually a RANGE: checking only the start line plus
 * three put `runtime.ts:782-788`'s window at 779-785, which does not contain
 * the quoted `wins outright` text at :786, and put `skill-catalogue.ts:98-104`'s
 * window at 95-101, which does not contain `Any other read failure throws.`
 * spanning :103-104. Both were false failures, so the window spans the whole
 * cited range.
 *
 * A claim fails when a quoted fragment of at least MIN_FRAGMENT characters
 * cannot be found within WINDOW lines of the cited range. Fragments are split on
 * elision markers (…), so an elided quote is checked piece by piece. Markdown
 * emphasis inside a quotation is stripped first, because the emphasis is added
 * by these docs and is not in the source.
 *
 * ⚠️ A citation to a file that exists nowhere in this repository is an
 * external reference — Cordis's `registry.ts`, WorkBuddy's `phase1.test.ts` —
 * and is skipped, but the skip count is reported. A gate that quietly drops
 * half its input is not a gate.
 */
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { test } from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");
const DOCS = path.join(ROOT, "docs");
/** Citations point at both halves of the repo, so both are searched. */
const SEARCH = [path.join(ROOT, "src"), path.join(ROOT, "test")];

/** Lines either side of the cited range that the passage may appear in. */
const WINDOW = 3;
/** Shorter fragments than this are not distinctive enough to prove anything. */
const MIN_FRAGMENT = 12;
/** How far back from a quotation its citation may sit. */
const BACK = 220;

/**
 * Known failures, each entry `doc:line → file:line` plus the reason it is not
 * fixed yet.
 *
 * ⚠️ Per D98 ⑤ these are listed explicitly rather than skipped silently: a
 * gate that waves a failure through without naming it is a report, not a gate.
 * ⚠️ And per D99: an entry may not be added to make the suite green. It is
 * added only once the failure has been diagnosed as a real defect that this
 * round cannot fix, and the reason must say which.
 */
const KNOWN: readonly string[] = [];

/** Collapse whitespace and strip comment markers, so a quoted comment matches. */
function normalize(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:\/\/+|\*+\/?|\/\*+)\s?/, "").trimEnd())
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Strip the markdown these docs add *inside* a quotation.
 *
 * ⚠️ The emphasis is mine, not the source's: the docs write `*"An injected
 * catalogue **wins outright rather than merging** with the disk one"*` where
 * the source has no asterisks. Backticks and the ⚠️ marker go for the same
 * reason — neither appears in a source comment.
 */
function stripMarkdown(text: string): string {
  return text.replace(/[*_`]/g, "").replace(/⚠️\s*/g, "");
}

/** Quotation styles these docs actually use, in one pattern. */
const QUOTE = /[*_]*["“「]([^"”」]{6,400})["”」][*_]*/g;
/** A backticked `file.ts:NNN` or `file.ts:NNN-NNN`, the range being the norm. */
const CITE = /`([A-Za-z0-9_.\-]+\.ts):(\d+)(?:-(\d+))?`/g;

type Claim = {
  readonly doc: string;
  readonly docLine: number;
  readonly src: string;
  readonly from: number;
  readonly to: number;
  readonly fragment: string;
};

function collect(): { readonly claims: Claim[]; readonly external: number } {
  const claims: Claim[] = [];
  let external = 0;
  const known = new Set<string>();
  for (const dir of SEARCH) {
    for (const f of readdirSync(dir)) if (f.endsWith(".ts")) known.add(f);
  }
  for (const name of readdirSync(DOCS).filter((f) => f.endsWith(".md")).sort()) {
    const lines = readFileSync(path.join(DOCS, name), "utf8").split(/\r?\n/);
    lines.forEach((line, index) => {
      for (const quote of line.matchAll(QUOTE)) {
        const at = quote.index ?? 0;
        // Backward window only: the citation precedes the passage it vouches for.
        const back = line.slice(Math.max(0, at - BACK), at);
        const cites = [...back.matchAll(CITE)];
        if (cites.length === 0) continue;
        const cite = cites[cites.length - 1]!;
        // The claim is only decidable when the document says "verbatim", and it
        // has to say so about THIS pair, so the marker sits between them.
        if (!back.slice(cite.index ?? 0).includes("逐字")) continue;
        const src = cite[1]!;
        if (!known.has(src)) {
          external += 1;
          continue;
        }
        const start = Number(cite[2]);
        // ⚠️ A range is the common case and its end is where the passage often
        // is, so an absent end means a single line, not "the rest of the file".
        const end = cite[3] === undefined ? start : Math.max(start, Number(cite[3]));
        for (const raw of quote[1]!.split(/…|\.{3,}|⋯/)) {
          const fragment = raw.trim();
          if (fragment.length < MIN_FRAGMENT) continue;
          claims.push({ doc: name, docLine: index + 1, src, from: start, to: end, fragment });
        }
      }
    });
  }
  return { claims, external };
}

test("每一条标了「逐字」的引文都能在所指文件的那一行附近找到", () => {
  const { claims, external } = collect();
  // ⚠️ A gate that silently collects nothing is worse than no gate: it reports
  // green while checking nothing. D90's first mutation was green for exactly
  // this reason, so the collection itself is asserted non-empty.
  assert.ok(claims.length > 0, `引文闸门没有收集到任何断言 —— 模式失配，不是文档干净`);

  const files = new Map<string, string>();
  for (const dir of SEARCH) {
    for (const f of readdirSync(dir)) {
      if (f.endsWith(".ts")) files.set(f, readFileSync(path.join(dir, f), "utf8"));
    }
  }
  const failures: string[] = [];
  for (const claim of claims) {
    const text = files.get(claim.src);
    const head = `${claim.doc}:${claim.docLine} → ${claim.src}:${claim.from}-${claim.to}`;
    if (text === undefined) {
      failures.push(`${head} 文件读不到`);
      continue;
    }
    const lines = text.split(/\r?\n/);
    if (claim.from > lines.length) {
      failures.push(`${head} 起点超出文件长度 ${lines.length}`);
      continue;
    }
    const from = Math.max(0, claim.from - 1 - WINDOW);
    const to = Math.min(lines.length, claim.to + WINDOW);
    // ⚠️ Both sides get the same treatment, or a backtick in the source
    // (`and \`assembleTaskPrompt\` with an empty catalogue`) fails a quote that
    // is otherwise verbatim. Symmetry is what makes the comparison meaningful.
    const haystack = stripMarkdown(normalize(lines.slice(from, to).join("\n")));
    const needle = normalize(stripMarkdown(claim.fragment));
    if (needle !== "" && !haystack.includes(needle)) {
      failures.push(`${head}\n    找不到：${JSON.stringify(claim.fragment.slice(0, 90))}`);
    }
  }

  const unknown = failures.filter((f) => !KNOWN.some((k) => f.includes(k)));
  assert.equal(
    unknown.length,
    0,
    `引文闸门：${claims.length} 条「逐字」断言里有 ${failures.length} 条不成立` +
      `（已知例外 ${KNOWN.length} 条；另有 ${external} 处引用指向本仓库之外的文件，已跳过）。\n  ` +
      unknown.join("\n  ") +
      `\n\n修法有三种，按优先级：改正行号；把「逐字」改成「大意」（如果它本来就是转述）；` +
      `或者把该行号加入 KNOWN 并写明理由。不要用第四种 —— 放宽 WINDOW 或 MIN_FRAGMENT 直到它变绿。`,
  );
});
