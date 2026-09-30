import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * The markdown table gate, moved into the suite (D103).
 *
 * It existed for several rounds as a PowerShell script typed fresh each time.
 * That version was measured to be wrong in a way that mattered: reading
 * `REFERENCE_DECISIONS.md` it reported 2254 lines where the file has 3036, and
 * its output contained mojibake (`澶辫触妗ｆ涓庤捀棣忥`), i.e. it was decoding
 * UTF-8 as GBK. Both of its counts — "HEAD BAD=7" and "this round BAD=14" — were
 * therefore unusable, and it had been the instrument behind earlier rounds'
 * "BAD = 0". A gate retyped every round is an assertion, not a check: nothing
 * makes it fail when the gate itself is wrong. In the suite it can, and during
 * this one it did — twice, both times on its own logic (see below).
 *
 * A malformed table row is not cosmetic. An unescaped `|` inside a cell splits
 * it, so the rendered document silently loses a column; when the count goes the
 * other way the cell has swallowed its neighbour's text. D80 measured both
 * directions in one table: `D15`(8), `D22`(10), `D24`(12), `D43`(14) against a
 * modal 4, and `D38`(3), `D39`(2) with *fewer* than the mode, which is content
 * loss rather than noise.
 *
 * The rule: group contiguous `|`-leading lines into blocks — one block is one
 * table, because "the header is the first row of the file's first table" fails as
 * soon as a blank line splits one — count only unescaped pipes, and require every
 * row to match its own block's header.
 */

const DOCS = path.join(import.meta.dirname ?? ".", "..", "docs");

/**
 * Rows exempted by name, and the granularity is the whole lesson of writing this
 * file. The first two attempts exempted whole BLOCKS, located by shape
 * (`/^\|? D\d+ \|/`) and then by shape plus filename. Measured: 34 blocks, then
 * 26. `REFERENCE_DECISIONS.md` has two dozen tables whose first column is a
 * D-number, so any block-level locator either misses the broken one or exempts
 * everything near it — and an exemption that broad is how a real defect hides.
 *
 * D80 recorded the defect by ROW, so the exemption is by row. Everything else in
 * that table stays checked.
 *
 * ⚠️ The list below was re-measured when this gate first ran, and the
 * measurement overturned D80's record in two ways. Both are kept here because
 * both are limitations of the check itself, not of the documents.
 *
 * 1. **D80's list is stale.** It recorded `D15`(8), `D22`(10), `D24`(12),
 *    `D30`(5), `D32`(5), `D41`(4), `D43`(14) against a modal 4, and `D38`(3),
 *    `D39`(2) as content loss. Measured now: the table's HEADER has 8 pipes, and
 *    every one of those rows except `D22` matches it. A modal count of 4 versus a
 *    header of 8 means the header was widened after D80 was written and the
 *    record was never re-taken. The rows that actually fail today are a different
 *    set: `D16`–`D21`, all at 4 pipes against that 8-pipe header.
 * 2. **A pipe COUNT cannot detect pipes in the wrong POSITIONS.** `D15`'s row
 *    contains `failed | cancelled` and `success | partial | failed | blocked`
 *    unescaped, so its columns are misaligned — and it passes, because its total
 *    happens to equal the header's. This gate therefore proves "every row has the
 *    same number of separators as its header", NOT "every row's columns line up".
 *    Stating the weaker property is the point: the stronger one was being assumed
 *    for several rounds by a script that could not even decode the file.
 *
 * Why these six are not simply repaired: repairing them needs the header's column
 * meanings, and two rows in the same table (`D38`, `D39` per D80) are suspected
 * of having LOST cell content rather than merely mis-split it. That is recoverable
 * from git history but was not this round's work.
 */
const KNOWN_BROKEN_ROWS: ReadonlyMap<string, string> = new Map([
  ["D16", "4 竖线，表头 8 —— 表头被改宽后这一行没跟上"],
  ["D17", "4 竖线，表头 8 —— 同上"],
  ["D18", "4 竖线，表头 8 —— 同上"],
  ["D19", "4 竖线，表头 8 —— 同上"],
  ["D20", "4 竖线，表头 8 —— 同上"],
  ["D21", "4 竖线，表头 8 —— 同上"],
  ["D22", "D80 记录为 10 竖线；本轮实测仍与表头不符，是 D80 那份名单里唯一还坏着的一行"],
]);

/** Unescaped pipes only: `\|` inside a cell is a literal, not a separator. */
function pipeCount(line: string): number {
  return (line.match(/(?<!\\)\|/g) ?? []).length;
}

/** The first cell's text, so an exemption can be matched by row identity. */
function firstCell(row: string): string {
  const parts = row.split("|");
  return (parts[1] ?? "").replace(/[*`\s]/g, "");
}

interface Finding {
  readonly where: string;
  readonly header: number;
  readonly row: number;
  readonly text: string;
}

interface Report {
  readonly files: number;
  readonly chars: number;
  readonly blocks: number;
  readonly rows: number;
  readonly bad: Finding[];
  readonly exempted: string[];
}

async function scan(): Promise<Report> {
  const names = (await readdir(DOCS)).filter((name) => name.endsWith(".md")).sort();
  const bad: Finding[] = [];
  const exempted: string[] = [];
  let blocks = 0;
  let rows = 0;
  let chars = 0;

  for (const name of names) {
    const bytes = await readFile(path.join(DOCS, name));
    const text = bytes.toString("utf8");
    chars += text.length;
    // Decoder self-check, and this is the part the PowerShell version lacked: a
    // wrong code page does not throw, it produces plausible-looking text with the
    // CJK turned to mojibake, and every count derived from it is wrong.
    //
    // Two rejected forms are worth keeping. Asserting that every document
    // contains the word 决定 failed on AUDIT.md, which legitimately does not. Then
    // asserting the absence of U+FFFD failed on REFERENCE_DECISIONS.md line 3025,
    // which contains three literal U+FFFD characters ON PURPOSE inside a sentence
    // describing a decoding bug: 「实测把一个汉字跨块切成两个 \uFFFD（哈希 →
    // \uFFFD\uFFFD希）」. A document about mojibake has to be able to show
    // mojibake. A check that cries wolf on correct input gets ignored, and then it
    // is not a gate. The round-trip is the sound form of the same intent — it
    // fails only when decoding actually lost information, and assumes nothing
    // about what the text says.
    assert.ok(Buffer.from(text, "utf8").equals(bytes), `${name}: UTF-8 往返不一致 —— 解码不可靠，后面所有计数都不可信`);

    const lines = text.split(/\r?\n/);
    let current: string[] = [];
    let start = 0;
    const flush = (): void => {
      if (current.length < 2) {
        current = [];
        return;
      }
      blocks += 1;
      const header = pipeCount(current[0] ?? "");
      current.forEach((line, index) => {
        if (index === 0) return;
        rows += 1;
        const count = pipeCount(line);
        if (count === header) return;
        const cell = firstCell(line);
        if (KNOWN_BROKEN_ROWS.has(cell)) {
          exempted.push(cell);
          return;
        }
        bad.push({ where: `${name}:${start + index + 1}`, header, row: count, text: line.slice(0, 90) });
      });
      current = [];
    };
    lines.forEach((line, index) => {
      if (/^\s*\|/.test(line)) {
        if (current.length === 0) start = index;
        current.push(line);
      } else {
        flush();
      }
    });
    flush();
  }
  return { files: names.length, chars, blocks, rows, bad, exempted };
}

describe("markdown table gate", () => {
  it("every table row has the same unescaped pipe count as its own header", async () => {
    const report = await scan();

    // Floors, in the shape the citation gate's calibration forced (D100): a
    // filter that collects nothing has not found a clean document, it has broken.
    // Each number is set below the measurement so ordinary edits do not trip it
    // while a runaway still does. The blocks floor already earned its keep once
    // during this file's own writing — see KNOWN_BROKEN_ROWS.
    assert.ok(report.files >= 6, `只扫到 ${report.files} 份文档 —— docs/ 没读到，不是文档干净`);
    assert.ok(report.chars > 100_000, `只读到 ${report.chars} 个字符 —— 解码或路径不对，不是文档干净`);
    assert.ok(report.blocks >= 40, `只收集到 ${report.blocks} 个表块 —— 分组过头了，不是文档干净`);
    assert.ok(report.rows >= 200, `只检查了 ${report.rows} 行表格 —— 分组过头了，不是文档干净`);

    const detail = report.bad
      .slice(0, 12)
      .map((item) => `  ${item.where} 表头 ${item.header} 竖线、该行 ${item.row} 竖线 :: ${item.text}`)
      .join("\n");
    assert.equal(
      report.bad.length,
      0,
      `${report.bad.length} 行表格与自己的表头竖线数不符（已检查 ${report.blocks} 个表块共 ${report.rows} 行、按行豁免 ${report.exempted.length} 行）。\n` +
        `单元格里的字面竖线必须写成 \\| 。三种允许的修法，和一种不允许的：\n` +
        `  ① 给单元格里的字面竖线加反斜杠；② 补齐被吞掉的列；③ 若确认是既有缺陷，先在本文件的 KNOWN_BROKEN_ROWS 注释里写清它为什么这一轮修不了，再把那一行加进名单。\n` +
        `  不要用第四种 —— 放宽分组规则或把整块豁免掉，那正是本文件前两版犯的错。\n` +
        detail,
    );
  });

  it("every exempted row is still actually broken, so the exemption cannot rot", async () => {
    const report = await scan();
    const found = new Set(report.exempted);
    const stale = [...KNOWN_BROKEN_ROWS.keys()].filter((name) => !found.has(name));
    assert.deepEqual(
      stale,
      [],
      `KNOWN_BROKEN_ROWS 里这些行已经不再损坏：${stale.join(", ")} —— 要么它们被修好了（那就把它们从名单里删掉），要么定位它们的形状失效了（那名单就在掩护别的东西）。豁免名单必须只包含真的还坏着的行`,
    );
  });
});
