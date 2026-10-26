/**
 * Hard meter ceilings, overridable registration bounds and scalar validators.
 * Host pricing and component handlers share exact nanodollar arithmetic.
 * The constants bound charge receipts, tree work, outbox batches and HTTP IO;
 * comments explain their effect on document size and transaction budgets.
 */
/** Hard ceilings keep row sizes, aggregate depth and action payloads predictable. */
export declare const LIMITS: {
    readonly deltaSeparator: ":delta:";
    readonly nanosPerUsd: 1000000000;
    readonly centsPerUsd: 100;
    readonly nanosPerCent: 10000000;
    readonly centDecimalPlaces: 7;
    readonly maxOperations: 32;
    readonly maxUsageNodes: 59;
    readonly reconcileBatch: 4;
    readonly tokensPerMillion: 1000000;
    readonly maxTokens: 1000000000;
    readonly aggregateNodeSize: 4;
    readonly dayMs: 86400000;
    readonly maxStringBytes: 128;
    readonly maxKeyBytes: 256;
    /**
     * $90 per charge. Every namespace whose totals must stay exact holds at most
     * maxThreadCharges priced entries (see aggregates.ts), so its sum is at most
     * 100_000 * 90_000_000_000 = 9_000_000_000_000_000 nanodollars, below
     * Number.MAX_SAFE_INTEGER = 9_007_199_254_740_991. Aggregate sums are float64;
     * staying under 2^53 keeps every integer total exact.
     */
    readonly maxChargeNanos: 90000000000;
    /**
     * A known amount above maxChargeNanos is kept (and billed) as `unknown` /
     * OVER_CAP up to this exact-integer ceiling. Aggregates count at most
     * maxChargeNanos of it (aggregates.ts), so every sum bound above still holds.
     */
    readonly maxBilledNanos: number;
    readonly maxQuantity: 1000000;
    /**
     * Per ROOT THREAD, never per deployment. threadCost range-reads the thread's
     * own trees, and that read budget needs a depth bound (aggregates.ts). A
     * charge past the bound is recorded `unknown` (reason THREAD_CAPACITY) in a
     * count-only overflow namespace, so the gate fails closed instead of throwing.
     */
    readonly maxThreadCharges: 100000;
    readonly maxProviders: 16;
    readonly maxProfiles: 32;
    readonly maxSinks: 4;
    readonly maxGroups: 4;
    readonly maxDays: 7;
    readonly maxLookupMs: 86400000;
    readonly lookupMs: 3600000;
    readonly backoffMs: 1000;
    readonly maxBackoffMs: 60000;
    readonly backoffBase: 2;
    readonly maxAttempts: 8;
    readonly maxParallelism: 4;
    /** Polar accepts at most 100 events per ingest request; one job sends one batch. */
    readonly sinkBatch: 100;
    /** Acknowledgements patch charge rows (<=280 KiB each, see charges.ts), so one
     * result mutation handles at most 16: 16 * 280 KiB = 4.4 MiB read and written. */
    readonly ackBatch: 16;
    /** New sink events wait this long so a burst shares one delivery request. */
    readonly deliveryWindowMs: 1000;
    readonly pruneLimit: 100;
    /** prune refuses a cutoff newer than now minus this (hosts may lower it):
     * pruning lowers run totals, so it must never reach an active budget window. */
    readonly pruneMinAgeMs: number;
    readonly maxPruneLimit: 500;
    /**
     * Worst-case prune accounting (charges.ts prune). Thread-scoped trees hold
     * <=maxThreadCharges entries: depth <=10. Subject- and run-scoped trees are
     * unbounded in count but depth 25 needs >=2*3^24-1 (~5.6e11) retained charges
     * for ONE subject, so 24 is the design ceiling. Node bytes <=2 KiB (aggregates.ts).
     */
    readonly threadTreeDepth: 10;
    readonly subjectTreeDepth: 24;
    readonly nodeBytes: 2048;
    readonly pruneReadBytes: number;
    readonly pruneReadDocs: 16000;
    readonly maxResponseBytes: 16384;
    readonly requestTimeoutMs: 30000;
    readonly maxTimestamp: 8640000000000000;
};
export type Limits = Pick<typeof LIMITS, "maxThreadCharges" | "maxGroups" | "maxDays" | "maxAttempts" | "pruneMinAgeMs">;
export type ResolvedLimits = {
    [K in keyof Limits]: number;
};
/** Reject fractional, negative or over-ceiling inputs at registration and operation boundaries. */
export declare function integer(value: number, max: number, name: string): number;
/** Bound nonempty UTF-8 labels and keys before persisting them or building aggregate keys. */
export declare function text(value: string, name: string, max?: number): string;
/** `max` is the per-charge cap for prices; callers that keep an over-cap
 * amount as OVER_CAP pass maxBilledNanos and compare against the cap. */
export declare function nanos(usd: number, max?: number): number;
/** Base events must use the raw charge key, so reserve the delta namespace. */
export declare function chargeKey(value: string): string;
/** Accept only named positive overrides within hard ceilings when the host registers meter. */
export declare function resolveLimits(overrides?: Partial<ResolvedLimits>): ResolvedLimits;
