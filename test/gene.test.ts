import { before, describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { DEFAULT_SELECTION_POLICY, canonicalize, geneAddress, mintGene, scoreCandidates, selectGene } from "../src/gene.ts";
import { GeneStore } from "../src/gene-store.ts";
import type { Gene, GeneExpression } from "../src/gene.ts";
import { SessionStore } from "../src/session-store.ts";
import { AgentRuntime } from "../src/runtime.ts";
import { createEchoAdapter } from "../src/echo-adapter.ts";
import { createScriptedAdapter } from "../src/echo-adapter.ts";
import { TASKSPEC_VERSION, buildTaskSpec, extractSignals } from "../src/taskspec.ts";
import { createTestFixture } from "./fixtures.ts";

let fixture: Awaited<ReturnType<typeof createTestFixture>>;

before(async () => {
  fixture = await createTestFixture("gene");
});

const NOW = 1_700_000_000_000;

function draft(overrides: Partial<Gene> = {}): Gene {
  return {
    name: "snippet-edit-discipline",
    intent: "build",
    signalsMatch: ["snippet", "编辑", "replace"],
    preconditions: ["目标文件已读"],
    strategy: [
      { kind: "guard", text: "读取整个目标文件" },
      { kind: "act", text: "用唯一锚点做最小片段替换" },
      { kind: "verify", text: "重读文件确认改动" },
    ],
    constraints: { maxFiles: 1, maxLines: 40, forbiddenPaths: ["docs/"] },
    validation: ["npm.cmd run build", "npm.cmd test"],
    avoid: ["不要整文件重写"],
    ...overrides,
  };
}

function expression(attempts: number, successes: number, lastAt: number | null = NOW): GeneExpression {
  return { attempts, successes, lastAt };
}

describe("mint", () => {
  it("mints a valid draft and derives a stable address", () => {
    const first = mintGene(draft());
    const second = mintGene(draft());
    assert.equal(first.address, second.address);
    assert.match(first.address, /^sha256:[0-9a-f]{64}$/);
    assert.equal(first.address, geneAddress(first.gene));
  });

  it("rejects an acting strategy with no verify step", () => {
    assert.throws(() => mintGene(draft({ strategy: [{ kind: "act", text: "do it" }] })), /must also verify/);
  });

  it("rejects a wrong intent, empty signals, missing validation, and non-positive budgets", () => {
    assert.throws(() => mintGene(draft({ intent: "spawn" as never })), /intent must be one of/);
    assert.throws(() => mintGene(draft({ signalsMatch: [] })), /signalsMatch/);
    assert.throws(() => mintGene(draft({ validation: [] })), /validation/);
    assert.throws(() => mintGene(draft({ constraints: { maxFiles: 0, maxLines: 10, forbiddenPaths: [] } })), /maxFiles/);
  });

  it("canonicalize is key-order independent", () => {
    assert.equal(canonicalize({ a: 1, b: 2 }), canonicalize({ b: 2, a: 1 }));
    assert.equal(canonicalize(undefined), "null");
  });
});

describe("gene store", () => {
  it("appends a gene idempotently and survives reload", async () => {
    const path = join(fixture.root, "idempotent.jsonl");
    const store = new GeneStore(path);
    const minted = mintGene(draft());
    await store.appendGene(minted, NOW);
    await store.appendGene(minted, NOW + 1);
    const text = await readFile(path, "utf8");
    assert.equal(text.split("\n").filter((line) => line !== "").length, 1);
    const reopened = new GeneStore(path);
    const state = await reopened.state();
    assert.ok(state.genes.has(minted.address));
  });

  it("folds outcomes into gene expression and the gene-less baseline", async () => {
    const path = join(fixture.root, "outcomes.jsonl");
    const store = new GeneStore(path);
    const minted = mintGene(draft());
    await store.appendGene(minted, NOW);
    await store.appendOutcome({ address: minted.address, succeeded: true }, NOW + 10);
    await store.appendOutcome({ address: minted.address, succeeded: false }, NOW + 20);
    await store.appendOutcome({ address: null, succeeded: true }, NOW + 30);
    const state = await store.state();
    const entry = state.genes.get(minted.address);
    assert.equal(entry?.expression.attempts, 2);
    assert.equal(entry?.expression.successes, 1);
    assert.equal(entry?.expression.lastAt, NOW + 20);
    assert.deepEqual({ ...state.baseline }, { attempts: 1, successes: 1 });
  });

  it("tolerates a truncated tail and refuses a malformed middle line", async () => {
    const path = join(fixture.root, "corrupt.jsonl");
    const store = new GeneStore(path);
    const minted = mintGene(draft());
    await store.appendGene(minted, NOW);
    const lines = (await readFile(path, "utf8")).split("\n");
    await writeFile(path, lines[0] + "\n{broken", "utf8");
    const tolerant = new GeneStore(path);
    const state = await tolerant.state();
    assert.ok(state.genes.has(minted.address));
    await writeFile(path, lines[0] + "\n{broken}\n" + JSON.stringify({ schema: 1, type: "outcome", at: NOW, address: null, succeeded: true }) + "\n", "utf8");
    const strict = new GeneStore(path);
    await assert.rejects(() => strict.state(), /line 2/);
  });

  it("selects nothing from an empty library — an honest gene-less round", async () => {
    const store = new GeneStore(join(fixture.root, "empty.jsonl"));
    assert.equal(await store.selectFor({ intent: "build", signals: ["snippet"], text: "用 snippet 替换" }), undefined);
  });
});

describe("selection", () => {
  it("gates on intent before weighing signals", () => {
    const minted = mintGene(draft());
    const scored = scoreCandidates([{ address: minted.address, gene: minted.gene, expression: expression(3, 3) }], { intent: "research", signals: ["snippet"], text: "snippet" });
    assert.equal(scored[0]?.excluded, "intent build does not match research");
  });

  it("matches signals as tokens and as CJK substrings", () => {
    const minted = mintGene(draft({ signalsMatch: ["小程序开发"] }));
    const { ranked, selection } = selectGene([{ address: minted.address, gene: minted.gene, expression: expression(0, 0, null) }], { intent: "build", signals: ["别的"], text: "帮我做小程序开发的报价" });
    assert.ok(selection);
    assert.equal(ranked.length, 1);
    assert.equal(selection.address, minted.address);
  });

  it("Laplace smoothing keeps 1/1 from outranking 9/10", () => {
    const one = mintGene(draft({ signalsMatch: ["snippet"], name: "one-shot" }));
    const steady = mintGene(draft({ signalsMatch: ["snippet"], name: "nine-of-ten" }));
    const { selection } = selectGene([
      { address: one.address, gene: one.gene, expression: expression(1, 1) },
      { address: steady.address, gene: steady.gene, expression: expression(10, 9) },
    ], { intent: "build", signals: ["snippet"], text: "snippet" }, DEFAULT_SELECTION_POLICY, NOW);
    assert.equal(selection?.address, steady.address);
  });

  it("decays the confidence of an old success, never the record", () => {
    const fresh = mintGene(draft({ signalsMatch: ["snippet"], name: "fresh" }));
    const stale = mintGene(draft({ signalsMatch: ["snippet"], name: "stale" }));
    const { selection } = selectGene([
      { address: stale.address, gene: stale.gene, expression: { attempts: 2, successes: 2, lastAt: NOW - DEFAULT_SELECTION_POLICY.halfLifeMs * 4 } },
      { address: fresh.address, gene: fresh.gene, expression: { attempts: 2, successes: 2, lastAt: NOW } },
    ], { intent: "build", signals: ["snippet"], text: "snippet" }, DEFAULT_SELECTION_POLICY, NOW);
    assert.equal(selection?.address, fresh.address);
  });

  it("excludes a gene that claims none of the request's vocabulary", () => {
    const minted = mintGene(draft({ signalsMatch: ["kubernetes"] }));
    const { selection, ranked } = selectGene([{ address: minted.address, gene: minted.gene, expression: expression(5, 5) }], { intent: "build", signals: ["snippet"], text: "snippet edit" });
    assert.equal(selection, null);
    assert.equal(ranked.length, 0);
  });
});

describe("task spec signals", () => {
  it("extracts word tokens and bumps the schema", () => {
    const spec = buildTaskSpec("研究 hello.txt 并总结");
    assert.equal(spec.schema, TASKSPEC_VERSION);
    assert.ok(spec.signals.includes("研究"));
    assert.ok(spec.signals.includes("hello"));
    assert.ok(extractSignals("  ").length === 0);
  });
});

describe("runtime applies and journals genes", () => {
  it("injects the selected gene as system context and records a success outcome", async () => {
    const store = new SessionStore({ root: fixture.storeRoot });
    const geneStore = new GeneStore(join(fixture.root, "runtime-success.jsonl"));
    const minted = mintGene(draft());
    await geneStore.appendGene(minted, NOW);
    const runtime = new AgentRuntime({
      adapter: createEchoAdapter(), store, sessionId: "gene-applied",
      home: fixture.home, workspaceRoot: fixture.workspaceRoot, geneStore,
    });
    const result = await runtime.send("用 snippet 方式替换这段代码");
    assert.equal(result.appliedGene?.address, minted.address);
    const system = result.history[0];
    assert.equal(system?.role, "system");
    assert.match(system?.content ?? "", new RegExp(`<applied_gene name="${minted.gene.name}"`));
    assert.match(system?.content ?? "", /\[guard\] 读取整个目标文件/);
    assert.match(system?.content ?? "", /不要整文件重写/);
    const state = await geneStore.state();
    assert.equal(state.genes.get(minted.address)?.expression.attempts, 1);
    assert.equal(state.genes.get(minted.address)?.expression.successes, 1);
  });

  it("records a gene-less baseline row when nothing matches", async () => {
    const store = new SessionStore({ root: fixture.storeRoot });
    const geneStore = new GeneStore(join(fixture.root, "runtime-baseline.jsonl"));
    const minted = mintGene(draft());
    await geneStore.appendGene(minted, NOW);
    const runtime = new AgentRuntime({
      adapter: createEchoAdapter(), store, sessionId: "gene-baseline",
      home: fixture.home, workspaceRoot: fixture.workspaceRoot, geneStore,
    });
    const result = await runtime.send("聊聊明天的天气");
    assert.equal(result.appliedGene, undefined);
    const state = await geneStore.state();
    assert.deepEqual({ ...state.baseline }, { attempts: 1, successes: 1 });
    assert.equal(state.genes.get(minted.address)?.expression.attempts, 0);
  });

  it("journals a failed round against the applied gene", async () => {
    const store = new SessionStore({ root: fixture.storeRoot });
    const geneStore = new GeneStore(join(fixture.root, "runtime-failure.jsonl"));
    const minted = mintGene(draft());
    await geneStore.appendGene(minted, NOW);
    const runtime = new AgentRuntime({
      adapter: createScriptedAdapter({ steps: [] }), store, sessionId: "gene-failed",
      home: fixture.home, workspaceRoot: fixture.workspaceRoot, geneStore,
    });
    await assert.rejects(() => runtime.send("用 snippet 方式替换"));
    const state = await geneStore.state();
    assert.equal(state.genes.get(minted.address)?.expression.attempts, 1);
    assert.equal(state.genes.get(minted.address)?.expression.successes, 0);
    // The next send is not poisoned by the failed round's leftover state.
    assert.equal(await geneStore.selectFor({ intent: "build", signals: ["snippet"], text: "snippet" }, NOW + 1000) === undefined, false);
  });
});
