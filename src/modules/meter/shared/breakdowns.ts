/**
 * Pure opt-in projection names and validation shared by both meter sides.
 * Host registration freezes enabled memberships onto each new charge.
 * Host reads and component queries use the same disabled-projection error,
 * so an unavailable breakdown cannot silently appear as an empty result.
 */
export const BREAKDOWNS = [
  "thread.model",
  "thread.provider",
  "subject.agent",
  "subject.model",
  "subject.provider",
] as const;

export type Breakdown = (typeof BREAKDOWNS)[number];

/** Explicit read failure when registration did not enable the requested projection. */
export class BreakdownDisabledError extends Error {
  readonly code = "BREAKDOWN_DISABLED";

  constructor(readonly breakdown: Breakdown) {
    super(`BREAKDOWN_DISABLED: enable breakdowns: ["${breakdown}"] in defineMeter options`);
    this.name = "BreakdownDisabledError";
  }
}

/** Validate registration/query memberships and deduplicate without changing their order. */
export function resolveBreakdowns(breakdowns: Breakdown[] = []): Breakdown[] {
  if (
    !Array.isArray(breakdowns) ||
    breakdowns.length > BREAKDOWNS.length ||
    breakdowns.some((value) => !BREAKDOWNS.includes(value))
  )
    throw new Error("INVALID_BREAKDOWNS");

  return [...new Set(breakdowns)];
}

/** Reject unavailable read projections before any aggregate query can imply empty data. */
export function requireBreakdown(enabled: Breakdown[], breakdown: Breakdown) {
  if (!enabled.includes(breakdown)) throw new BreakdownDisabledError(breakdown);
}
