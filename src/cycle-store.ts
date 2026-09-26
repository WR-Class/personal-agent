/**
 * The cycle journal: an append-only log of PDRI events, folded on read (D15).
 *
 * Same discipline as the gene library: the log is the fact and the state is a
 * fold over it, a truncated tail (a crash mid-append) is dropped rather than
 * guessed at, and a malformed middle line is refused with its line number
 * instead of being skipped. It is an operational record of what the agent did —
 * the session log stays the conversation's fact source (ADR-0001).
 */
import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

import { type CycleEvent, type CycleState, replay } from "./cycle.ts";

const SCHEMA = 1;

interface CycleRecord {
  schema: number;
  type: "cycle";
  at: number;
  cycleId: string;
  sessionId: string;
  event: CycleEvent;
}

export class CycleStore {
  private records: CycleRecord[] | null = null;
  private readonly path: string;

  constructor(path: string) {
    this.path = path;
  }

  private async load(): Promise<CycleRecord[]> {
    if (this.records) return this.records;
    let text: string;
    try { text = await readFile(this.path, "utf8"); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { this.records = []; return this.records; }
      throw error;
    }
    const lines = text.split("\n");
    // The writer always ends with "\n", so dropping the final split element
    // removes the trailing empty artifact on a healthy log — and removes the
    // partial line a crash left behind when the file ends mid-record.
    if (lines.length > 0) lines.pop();
    const parsed: CycleRecord[] = [];
    for (let index = 0; index < lines.length; index++) {
      try {
        const record = JSON.parse(lines[index] ?? "") as CycleRecord;
        if (record?.schema !== SCHEMA || record.type !== "cycle" || typeof record.cycleId !== "string" || !record.event) {
          throw new Error("unsupported record");
        }
        parsed.push(record);
      }
      catch (error) {
        throw new Error(`cycle store line ${index + 1} is not a valid v${SCHEMA} record: ${(error as Error).message}`);
      }
    }
    this.records = parsed;
    return parsed;
  }

  /** Journal one event. Legality was already enforced by the state machine. */
  async append(sessionId: string, cycleId: string, event: CycleEvent, at: number = Date.now()): Promise<void> {
    const records = await this.load();
    const record: CycleRecord = { schema: SCHEMA, type: "cycle", at, cycleId, sessionId, event };
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${JSON.stringify(record)}\n`, "utf8");
    records.push(record);
  }

  /**
   * Fold every cycle to its current state. A cycle the log never closed stays in
   * its last live phase — visible as unfinished, never silently completed.
   */
  async states(): Promise<Map<string, CycleState>> {
    const records = await this.load();
    const events = new Map<string, { startedAt: number; events: CycleEvent[] }>();
    for (const record of records) {
      const entry = events.get(record.cycleId) ?? { startedAt: record.at, events: [] };
      if (entry.events.length === 0 && record.event.type === "fail") entry.startedAt = record.at;
      entry.events.push(record.event);
      events.set(record.cycleId, entry);
    }
    const states = new Map<string, CycleState>();
    for (const [cycleId, entry] of events) states.set(cycleId, replay(cycleId, entry.startedAt, entry.events));
    return states;
  }
}
