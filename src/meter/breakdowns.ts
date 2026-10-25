export const BREAKDOWNS = [
  "thread.model",
  "thread.provider",
  "subject.agent",
  "subject.model",
  "subject.provider",
] as const;

export type Breakdown = (typeof BREAKDOWNS)[number];

export class BreakdownDisabledError extends Error {
  readonly code = "BREAKDOWN_DISABLED";

  constructor(readonly breakdown: Breakdown) {
    super(`BREAKDOWN_DISABLED: enable breakdowns: ["${breakdown}"] in defineMeter options`);
    this.name = "BreakdownDisabledError";
  }
}

export function resolveBreakdowns(breakdowns: Breakdown[] = []): Breakdown[] {
  if (
    !Array.isArray(breakdowns) ||
    breakdowns.length > BREAKDOWNS.length ||
    breakdowns.some((value) => !BREAKDOWNS.includes(value))
  )
    throw new Error("INVALID_BREAKDOWNS");

  return [...new Set(breakdowns)];
}

export function requireBreakdown(enabled: Breakdown[], breakdown: Breakdown) {
  if (!enabled.includes(breakdown)) throw new BreakdownDisabledError(breakdown);
}
