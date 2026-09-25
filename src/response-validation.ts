import type { ChatResponse } from "./types.ts";
export function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`invalid model response: ${label}`);
  return value as Record<string, unknown>;
}
export function tokenCount(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("invalid model response: token count");
  return value;
}
export function validateResponse(value: unknown): asserts value is ChatResponse {
  const r = record(value, "object");
  if (typeof r.content !== "string" || typeof r.model !== "string" || !r.model.trim() || !Array.isArray(r.toolCalls)) {
    throw new Error("invalid model response: content/model/toolCalls");
  }
  if (r.reasoning !== undefined && typeof r.reasoning !== "string") {
    throw new Error("invalid model response: reasoning");
  }
  const ids = new Set<string>();
  for (const raw of r.toolCalls) {
    const call = record(raw, "tool call");
    if (typeof call.id !== "string" || !call.id.trim() || ids.has(call.id) || typeof call.name !== "string" ||
        !call.name.trim() || typeof call.arguments !== "string") throw new Error("invalid model response: tool id/name/arguments");
    ids.add(call.id);
  }
  const usage = record(r.usage, "usage");tokenCount(usage.inputTokens);tokenCount(usage.outputTokens);
  // Malformed only. Whether the provider's "reasoning" share really is a subset of
  // its output count is not something this project can verify, so it is reported
  // as provider-reported rather than second-guessed here.
  if (usage.reasoningTokens !== undefined) tokenCount(usage.reasoningTokens);
}
