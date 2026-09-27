import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { actionBinding } from "../src/file-policy.ts";

describe("action binding", () => {
  it("treats key order as the same action", () => {
    // The bug this replaces: these two used to hash differently, so the second
    // identical request missed the grant and prompted the operator again.
    const a = actionBinding("create_file", { path: "a.txt", content: "x" });
    const b = actionBinding("create_file", { content: "x", path: "a.txt" });
    assert.equal(a, b);
  });

  it("treats nested key order as the same action", () => {
    const a = actionBinding("t", { path: "a.txt", opts: { x: 1, y: 2 } });
    const b = actionBinding("t", { path: "a.txt", opts: { y: 2, x: 1 } });
    assert.equal(a, b);
  });

  it("changes when any value changes", () => {
    const a = actionBinding("create_file", { path: "a.txt", content: "x" });
    const b = actionBinding("create_file", { path: "a.txt", content: "y" });
    assert.notEqual(a, b);
  });

  it("never lets one tool's grant satisfy another", () => {
    const a = actionBinding("create_file", { path: "a.txt", content: "x" });
    const b = actionBinding("delete_file", { path: "a.txt", content: "x" });
    assert.notEqual(a, b);
  });

  it("is insensitive to how the arguments were spelled as text", () => {
    // Same data, different literal spelling: parsing first makes these equal.
    const fromText = actionBinding("create_file", JSON.parse('{ "path" : "a.txt" , "content" : "x" }'));
    const fromObject = actionBinding("create_file", { path: "a.txt", content: "x" });
    assert.equal(fromText, fromObject);
  });

  it("ignores undefined-valued keys instead of inventing a difference", () => {
    const a = actionBinding("t", { path: "a.txt", content: undefined });
    const b = actionBinding("t", { path: "a.txt" });
    assert.equal(a, b);
  });

  it("distinguishes array order, which is real data", () => {
    const a = actionBinding("t", { paths: ["a", "b"] });
    const b = actionBinding("t", { paths: ["b", "a"] });
    assert.notEqual(a, b);
  });

  it("is a stable content address with a recognizable prefix", () => {
    const a = actionBinding("t", { path: "a.txt" });
    assert.match(a, /^sha256:[0-9a-f]{64}$/);
    assert.equal(a, actionBinding("t", { path: "a.txt" }));
  });
});
