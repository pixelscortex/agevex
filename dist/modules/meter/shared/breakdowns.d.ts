/**
 * Pure opt-in projection names and validation shared by both meter sides.
 * Host registration freezes enabled memberships onto each new charge.
 * Host reads and component queries use the same disabled-projection error,
 * so an unavailable breakdown cannot silently appear as an empty result.
 */
export declare const BREAKDOWNS: readonly ["thread.model", "thread.provider", "subject.agent", "subject.model", "subject.provider"];
export type Breakdown = (typeof BREAKDOWNS)[number];
/** Explicit read failure when registration did not enable the requested projection. */
export declare class BreakdownDisabledError extends Error {
    readonly breakdown: Breakdown;
    readonly code = "BREAKDOWN_DISABLED";
    constructor(breakdown: Breakdown);
}
/** Validate registration/query memberships and deduplicate without changing their order. */
export declare function resolveBreakdowns(breakdowns?: Breakdown[]): Breakdown[];
/** Reject unavailable read projections before any aggregate query can imply empty data. */
export declare function requireBreakdown(enabled: Breakdown[], breakdown: Breakdown): void;
