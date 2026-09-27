/**
 * Reading binary content (D38).
 *
 * The behaviour under test replaced a silent corruption. `read_file` used to
 * decode everything as UTF-8, so a byte that was not valid UTF-8 became U+FFFD
 * and the original byte was unrecoverable — measured, `89 50 4e 47 ff fe fd 00`
 * came back as `efbfbd 50 4e 47 efbfbd efbfbd efbfbd 00`, which is neither the
 * same bytes nor even the same length. For reviewing a binary that is worse than
 * refusing, because it looks like text and carries no signal of damage.
 */
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { createReadFileTool } from "../src/tools.ts";

let workspace: string;
const read = async (name: string, args: Record<string, unknown> = {}) =>
  createReadFileTool().execute({ path: path.join(workspace, name), ...args }, { workspaceRoot: workspace });

before(async () => {
  // Deliberately not under the OS temp dir: that sits inside a protected host
  // tree, and a probe that used it was refused for the wrong reason.
  workspace = path.join(process.cwd(), ".test-artifacts", `binary-read-${process.pid}`);
  await mkdir(workspace, { recursive: true });
});

after(async () => {
  await rm(workspace, { recursive: true, force: true });
});

describe("reading binary files", () => {
  it("returns hex for bytes that are not valid UTF-8", async () => {
    await writeFile(path.join(workspace, "hdr.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0xff, 0xfe, 0xfd, 0x00]));
    const result = await read("hdr.dat");
    assert.notEqual(result.isError, true);
    const text = String(result.content);
    assert.match(text, /binary file/);
    assert.match(text, /89 50 4e 47/);
  });

  it("never emits a replacement character", async () => {
    await writeFile(path.join(workspace, "hdr2.dat"), Buffer.from([0x89, 0x50, 0xff, 0xfe, 0xfd]));
    const result = await read("hdr2.dat");
    // The old path turned every one of these into U+FFFD. Their presence would
    // mean the lossy decode came back.
    assert.ok(!String(result.content).includes("\uFFFD"));
  });

  it("treats a NUL-containing header as binary even though it is valid UTF-8", async () => {
    // A real DOS header is all bytes under 0x80, so it round-trips through UTF-8
    // and a round-trip check alone calls it text. It is 57 NULs out of 64.
    await writeFile(path.join(workspace, "dos.dat"), Buffer.from("MZx\u0000\u0001\u0000\u0000\u0000", "latin1"));
    const result = await read("dos.dat");
    assert.match(String(result.content), /binary file/);
    assert.match(String(result.content), /4d 5a 78/);
  });

  it("round-trips every byte value through the hex view", async () => {
    const all = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
    await writeFile(path.join(workspace, "all.bin"), all);
    const text = String((await read("all.bin")).content);
    const recovered: number[] = [];
    for (const line of text.split("\n")) {
      const match = line.match(/^[0-9a-f]{8}  ((?:[0-9a-f]{2} )+)/);
      if (match?.[1]) for (const pair of match[1].trim().split(/\s+/)) recovered.push(parseInt(pair, 16));
    }
    // Losslessness is the entire requirement, so it is asserted against the
    // original bytes rather than against the rendering being plausible.
    assert.ok(Buffer.from(recovered).equals(all));
  });

  it("leaves ASCII text byte-for-byte unchanged", async () => {
    const content = "hello\nworld\n";
    await writeFile(path.join(workspace, "a.txt"), content, "utf8");
    const result = await read("a.txt");
    assert.equal(String(result.content), content);
  });

  it("leaves multi-byte UTF-8 text unchanged", async () => {
    const content = "中文测试\n第二行\n";
    await writeFile(path.join(workspace, "b.txt"), content, "utf8");
    const result = await read("b.txt");
    assert.equal(String(result.content), content);
  });
});

describe("reading part of a large file", () => {
  it("refuses a whole-file read over the limit but names the way through", async () => {
    const big = Buffer.alloc(400 * 1024, 0x41);
    await writeFile(path.join(workspace, "big.dat"), big);
    const result = await read("big.dat");
    assert.equal(result.isError, true);
    assert.match(String(result.content), /offset/);
  });

  it("reads a header from a file larger than the limit", async () => {
    const big = Buffer.alloc(400 * 1024, 0x00);
    big.write("MZ", 0, "latin1");
    await writeFile(path.join(workspace, "big2.dat"), big);
    const result = await read("big2.dat", { offset: 0, length: 64 });
    assert.notEqual(result.isError, true);
    assert.match(String(result.content), /4d 5a/);
  });

  it("reports file-absolute offsets so a range can be continued", async () => {
    const big = Buffer.alloc(400 * 1024, 0x00);
    big.writeUInt8(0xab, 0x80);
    await writeFile(path.join(workspace, "big3.dat"), big);
    const text = String((await read("big3.dat", { offset: 0x80, length: 16 })).content);
    assert.match(text, /00000080/);
    assert.match(text, /ab/);
  });

  it("refuses a negative or non-integer offset", async () => {
    await writeFile(path.join(workspace, "c.txt"), "x");
    for (const bad of [-1, 1.5]) {
      const result = await read("c.txt", { offset: bad });
      assert.equal(result.isError, true);
      assert.match(String(result.content), /non-negative integer/);
    }
  });

  it("refuses an offset past the end of the file", async () => {
    await writeFile(path.join(workspace, "d.txt"), "short");
    const result = await read("d.txt", { offset: 999 });
    assert.equal(result.isError, true);
    assert.match(String(result.content), /past the end/);
  });

  it("refuses a zero length rather than returning nothing", async () => {
    await writeFile(path.join(workspace, "e.txt"), "short");
    const result = await read("e.txt", { length: 0 });
    assert.equal(result.isError, true);
    assert.match(String(result.content), /greater than zero/);
  });
});
