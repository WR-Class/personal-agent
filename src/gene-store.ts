/**
 * Append-only persistence for the gene library (D14).
 *
 * The store is a log, not a database of current values (mechanism adopted
 * from dsh-swarm core/store.ts): every mutation appends a record and the
 * current state is a fold over the log. Content-addressed gene records make
 * re-appending the same gene idempotent, and a truncated final line is
 * tolerated (a crash during append) while a malformed middle line is refused
 * (damage that would silently change what the library contains).
 *
 * Outcome rows with `address: null` are the gene-less baseline — the
 * counterfactual that future gain pricing needs, recorded from day one.
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import {
  DEFAULT_SELECTION_POLICY,
  selectGene,
  type Gene,
  type GeneExpression,
  type GeneRequest,
  type MintedGene,
  type ScoredCandidate,
} from "./gene.ts";

const SCHEMA = 1;

export type GeneStoreRecord =
  | { readonly schema: 1; readonly type: "gene"; readonly at: number; readonly address: string; readonly gene: Gene }
  | { readonly schema: 1; readonly type: "outcome"; readonly at: number; readonly address: string | null; readonly succeeded: boolean };

export interface GeneLibraryState {
  /** Live genes with their folded expression counters. */
  readonly genes: ReadonlyMap<string, { gene: Gene; expression: GeneExpression }>;
  /** Gene-less baseline outcomes, the counterfactual for future gain pricing. */
  readonly baseline: { attempts: number; successes: number };
}

export interface AppliedGene {
  readonly address: string;
  readonly name: string;
  /** The block injected into this send's system prompt (test-time evolution). */
  readonly block: string;
}

export class GeneStore {
  private records: GeneStoreRecord[] | null = null;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  /** Parse the log once; later appends update the in-memory fold. */
  async load(): Promise<void> {
    let text: string;
    try {
      text = await readFile(this.path, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.records = []; return; }
      throw error;
    }
    const lines = text.split("\n");
    // The writer always ends with "\n", so dropping the final split element
    // removes the trailing empty artifact on a healthy log — and removes the
    // partial line a crash left behind when the file ends mid-record.
    if (lines.length > 0) lines.pop();
    const parsed: GeneStoreRecord[] = [];
    for (let index = 0; index < lines.length; index++) {
      try {
        const record = JSON.parse(lines[index] ?? "") as GeneStoreRecord;
        if (record.schema !== SCHEMA || (record.type !== "gene" && record.type !== "outcome")) {
          throw new Error(`unsupported record`);
        }
        parsed.push(record);
      } catch (error) {
        throw new Error(`gene store line ${index + 1} is not a valid v${SCHEMA} record: ${(error as Error).message}`);
      }
    }
    this.records = parsed;
  }

  private async ensureLoaded(): Promise<GeneStoreRecord[]> {
    if (this.records === null) await this.load();
    return this.records!;
  }

  /** Idempotent by address: the same gene appended twice is one gene. */
  async appendGene(minted: MintedGene, at: number = Date.now()): Promise<void> {
    const records = await this.ensureLoaded();
    if (records.some((record) => record.type === "gene" && record.address === minted.address)) return;
    await this.append({ schema: SCHEMA, type: "gene", at, address: minted.address, gene: minted.gene });
  }

  async appendOutcome(outcome: { address: string | null; succeeded: boolean }, at: number = Date.now()): Promise<void> {
    await this.append({ schema: SCHEMA, type: "outcome", at, ...outcome });
  }

  private async append(record: GeneStoreRecord): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    this.records?.push(record);
  }

  /** Current state: the fold over the whole log. */
  async state(): Promise<GeneLibraryState> {
    const records = await this.ensureLoaded();
    const genes = new Map<string, { gene: Gene; expression: GeneExpression }>();
    const baseline = { attempts: 0, successes: 0 };
    for (const record of records) {
      if (record.type === "gene") {
        if (!genes.has(record.address)) genes.set(record.address, { gene: record.gene, expression: { attempts: 0, successes: 0, lastAt: null } });
        continue;
      }
      if (record.address === null) {
        baseline.attempts += 1;
        if (record.succeeded) baseline.successes += 1;
        continue;
      }
      const entry = genes.get(record.address);
      if (!entry) continue;
      entry.expression.attempts += 1;
      if (record.succeeded) entry.expression.successes += 1;
      entry.expression.lastAt = record.at;
    }
    return { genes, baseline };
  }

  /**
   * Select a gene for one request and render its injection block. Returns
   * undefined when no live candidate matches — an honest gene-less round.
   */
  async selectFor(request: GeneRequest, now: number = Date.now()): Promise<AppliedGene | undefined> {
    const state = await this.state();
    const candidates = [...state.genes.entries()].map(([address, entry]) => ({ address, gene: entry.gene, expression: entry.expression }));
    const { selection } = selectGene(candidates, request, DEFAULT_SELECTION_POLICY, now);
    if (!selection) return undefined;
    return { address: selection.address, name: selection.gene.name, block: renderGeneBlock(selection) };
  }
}

/** Test-time injection: the strategy and warnings, never the constraints. */
function renderGeneBlock(candidate: ScoredCandidate): string {
  const gene = candidate.gene;
  const lines: string[] = [`<applied_gene name="${gene.name}" address="${candidate.address}">`];
  if (gene.preconditions.length > 0) lines.push(`Preconditions:`, ...gene.preconditions.map((item) => `- ${item}`));
  lines.push(`Proven strategy, follow in order:`, ...gene.strategy.map((step) => `- [${step.kind}] ${step.text}`));
  if (gene.validation.length > 0) lines.push(`Prove it worked:`, ...gene.validation.map((item) => `- ${item}`));
  if (gene.avoid.length > 0) lines.push(`Avoid, distilled from past failures:`, ...gene.avoid.map((item) => `- ${item}`));
  lines.push(`</applied_gene>`);
  return lines.join("\n");
}
