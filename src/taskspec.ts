/**
 * TaskSpec: what this send is for, decided before the model is called.
 *
 * Mechanism borrowed from dsh-lab's dsh-orchestrator (recorded as D12): a
 * deterministic, versioned spec built from the user's input; the mode is set
 * by the runtime, never by the model; a missing objective is recorded as an
 * unknown, never invented; enforcement is a separate, default-off switch.
 *
 * Schema 2 adds `signals`: the request vocabulary that gene selection weighs
 * (D14). The spec is the front door — its intent gates the gene library, its
 * signals score it.
 */
export const TASKSPEC_VERSION = 2;

/** The one mode this runtime runs today. The runtime sets it; the model cannot. */
export const TASK_MODE = "single-agent";

export type TaskIntent = "build" | "fix" | "research" | "verify" | "operate";

export interface TaskSpec {
  schema: number;
  /** The user's own words, preserved verbatim. */
  originalInput: string;
  objective: string;
  /** Keyword classification, deterministic but not authority. */
  intent: TaskIntent;
  /** Request vocabulary for gene selection: tokens plus the raw text stay available for substring matching. */
  signals: string[];
  /** Set by the runtime. Undefined means no mode was decided — never guessed. */
  selectedMode?: string;
  /** Which required facts were missing. Empty means the spec is complete. */
  unknowns: string[];
  evidence: { authoritativeMode: boolean };
}

/** Structured input keeps its first text part, mirroring dsh-orchestrator. */
type SpecInput = string | { content?: ReadonlyArray<{ type?: string; text?: string } & Record<string, unknown>> };

const INTENT_HINTS: ReadonlyArray<readonly [TaskIntent, RegExp]> = [
  ["fix", /修复|修正|bug|fix/i],
  ["verify", /验证|核实|测试通过|verify|test/i],
  ["research", /调研|研究|research/i],
  ["operate", /部署|上线|operate|deploy/i],
];

function firstText(input: SpecInput): string {
  if (typeof input === "string") return input;
  for (const part of input.content ?? []) {
    if (part.type === "text" && typeof part.text === "string") return part.text;
  }
  return "";
}

/**
 * Extract the request vocabulary gene selection matches against. Word tokens
 * for languages that have them; Chinese phrases have no spaces to split on, so
 * selection additionally matches gene signals as substrings of the raw text.
 */
export function extractSignals(text: string): string[] {
  const normalized = text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  if (normalized === "") return [];
  return [...new Set(normalized.split(/\s+/u).filter((token) => token.length > 1))];
}

export function buildTaskSpec(input: SpecInput, options: { mode?: string } = {}): TaskSpec {
  const originalInput = firstText(input);
  const objective = originalInput.trim();
  const unknowns: string[] = [];
  if (objective === "") unknowns.push("objective");
  let intent: TaskIntent = "build";
  for (const [candidate, hint] of INTENT_HINTS) {
    if (hint.test(originalInput)) { intent = candidate; break; }
  }
  const hasMode = options.mode !== undefined;
  if (!hasMode) unknowns.push("mode");
  return {
    schema: TASKSPEC_VERSION,
    originalInput,
    objective,
    intent,
    signals: extractSignals(originalInput),
    ...(hasMode ? { selectedMode: options.mode } : {}),
    unknowns,
    evidence: { authoritativeMode: hasMode },
  };
}

/**
 * Enforcement is a separate switch and defaults to off, exactly as in the
 * reference: an incomplete spec is reported, not treated as fatal, until the
 * operator opts into hard refusal.
 */
export function assessTaskSpec(spec: TaskSpec, options: { enforce?: boolean } = {}): { blocked: boolean; reason?: string } {
  if (!options.enforce || spec.unknowns.length === 0) return { blocked: false };
  return { blocked: true, reason: `task spec incomplete: ${spec.unknowns.join(", ")}` };
}
