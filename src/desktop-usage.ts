import type { SessionEvent } from './session-store.ts';

export interface DesktopUsageSummary {
  turns: number;
  steps: number;
  inputTokens: number | null;
  outputTokens: number | null;
  totalTokens: number | null;
  tokensPerSecond: number | null;
  cachedInputTokens: number | null;
  cacheHitPercent: number | null;
  contextPercent: null;
  partial: boolean;
}

/** Recorded model responses only; tools never add tokens or request duration. */
export function desktopUsageSummary(events: SessionEvent[]): DesktopUsageSummary {
  const messages = events.filter(e => e.kind === 'message');
  const turns = messages.filter(e => e.message.role === 'user').length;
  const steps = messages.filter(e => e.message.role === 'assistant').length;
  const usages = events.filter(e => e.kind === 'usage').map(e => e.usage);
  // Pre-metadata positive counts are useful but cannot prove complete provider reporting.
  const known = usages.filter(u => u.reported === true || (u.reported === undefined && u.inputTokens + u.outputTokens > 0));
  const safe = (n: number): number | null => Number.isSafeInteger(n) && n >= 0 ? n : null;
  const inputTokens = known.length ? safe(known.reduce((n, u) => n + u.inputTokens, 0)) : null;
  const outputTokens = known.length ? safe(known.reduce((n, u) => n + u.outputTokens, 0)) : null;
  const totalTokens = inputTokens === null || outputTokens === null ? null : safe(inputTokens + outputTokens);
  const complete = usages.length > 0 && usages.length === steps && usages.every(u => u.reported === true);
  const cachedInputTokens = complete && usages.every(u => u.cachedInputTokens !== undefined)
    ? safe(usages.reduce((n, u) => n + u.cachedInputTokens!, 0)) : null;
  const latest = usages.at(-1);
  // Latest request's average output speed includes network/body time, never tool execution.
  const rate = latest?.reported === true && latest.durationMs !== undefined && latest.durationMs > 0
    ? latest.outputTokens / latest.durationMs * 1000 : null;
  return {
    turns, steps, inputTokens, outputTokens, totalTokens,
    tokensPerSecond: rate !== null && Number.isFinite(rate) ? rate : null,
    cachedInputTokens,
    cacheHitPercent: cachedInputTokens !== null && inputTokens !== null && inputTokens > 0 ? cachedInputTokens / inputTokens * 100 : null,
    // No trustworthy configured context window exists in this desktop adapter.
    contextPercent: null,
    partial: (steps > 0 || usages.length > 0) && (!complete || totalTokens === null),
  };
}
