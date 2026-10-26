/**
 * Hard meter ceilings, overridable registration bounds and scalar validators.
 * Host pricing and component handlers share exact nanodollar arithmetic.
 * The constants bound charge receipts, tree work, outbox batches and HTTP IO;
 * comments explain their effect on document size and transaction budgets.
 */
/** Hard ceilings keep row sizes, aggregate depth and action payloads predictable. */
export const LIMITS = {
  deltaSeparator: ":delta:",
  nanosPerUsd: 1_000_000_000,
  centsPerUsd: 100,
  nanosPerCent: 10_000_000,
  centDecimalPlaces: 7,
  maxOperations: 32,
  maxUsageNodes: 59,
  reconcileBatch: 4,
  tokensPerMillion: 1_000_000,
  maxTokens: 1_000_000_000,
  aggregateNodeSize: 4,
  dayMs: 86_400_000,
  maxStringBytes: 128,
  maxKeyBytes: 256,
  // Provider tokens are far shorter; the bound only stops a runaway getter.
  maxCredentialBytes: 4096,
  /**
   * $90 per charge. Every namespace whose totals must stay exact holds at most
   * maxThreadCharges priced entries (see aggregates.ts), so its sum is at most
   * 100_000 * 90_000_000_000 = 9_000_000_000_000_000 nanodollars, below
   * Number.MAX_SAFE_INTEGER = 9_007_199_254_740_991. Aggregate sums are float64;
   * staying under 2^53 keeps every integer total exact.
   */
  maxChargeNanos: 90_000_000_000,
  /**
   * A known amount above maxChargeNanos is kept (and billed) as `unknown` /
   * OVER_CAP up to this exact-integer ceiling. Aggregates count at most
   * maxChargeNanos of it (aggregates.ts), so every sum bound above still holds.
   */
  maxBilledNanos: Number.MAX_SAFE_INTEGER,
  maxQuantity: 1_000_000,
  /**
   * Per ROOT THREAD, never per deployment. threadCost range-reads the thread's
   * own trees, and that read budget needs a depth bound (aggregates.ts). A
   * charge past the bound is recorded `unknown` (reason THREAD_CAPACITY) in a
   * count-only overflow namespace, so the gate fails closed instead of throwing.
   */
  maxThreadCharges: 100_000,
  maxProviders: 16,
  maxProfiles: 32,
  maxSinks: 4,
  maxGroups: 4,
  maxDays: 7,
  maxLookupMs: 86_400_000,
  lookupMs: 3_600_000,
  backoffMs: 1_000,
  maxBackoffMs: 60_000,
  backoffBase: 2,
  maxAttempts: 8,
  maxParallelism: 4,
  /** Polar accepts at most 100 events per ingest request; one job sends one batch. */
  sinkBatch: 100,
  /** Acknowledgements patch charge rows (<=280 KiB each, see charges.ts), so one
   * result mutation handles at most 16: 16 * 280 KiB = 4.4 MiB read and written. */
  ackBatch: 16,
  /** New sink events wait this long so a burst shares one delivery request. */
  deliveryWindowMs: 1_000,
  pruneLimit: 100,
  /** prune refuses a cutoff newer than now minus this (hosts may lower it):
   * pruning lowers run totals, so it must never reach an active budget window. */
  pruneMinAgeMs: 7 * 86_400_000,
  maxPruneLimit: 500,
  /**
   * Worst-case prune accounting (charges.ts prune). Thread-scoped trees hold
   * <=maxThreadCharges entries: depth <=10. Subject- and run-scoped trees are
   * unbounded in count but depth 25 needs >=2*3^24-1 (~5.6e11) retained charges
   * for ONE subject, so 24 is the design ceiling. Node bytes <=2 KiB (aggregates.ts).
   */
  threadTreeDepth: 10,
  subjectTreeDepth: 24,
  nodeBytes: 2_048,
  pruneReadBytes: 12 * 1024 * 1024,
  pruneReadDocs: 16_000,
  maxResponseBytes: 16_384,
  requestTimeoutMs: 30_000,
  maxTimestamp: 8_640_000_000_000_000,
} as const;

export type Limits = Pick<
  typeof LIMITS,
  "maxThreadCharges" | "maxGroups" | "maxDays" | "maxAttempts" | "pruneMinAgeMs"
>;
export type ResolvedLimits = { [K in keyof Limits]: number };
const overridable = ["maxThreadCharges", "maxGroups", "maxDays", "maxAttempts", "pruneMinAgeMs"];

/** Reject fractional, negative or over-ceiling inputs at registration and operation boundaries. */
export function integer(value: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`INVALID_${name}`);

  return value;
}

/** Bound nonempty UTF-8 labels and keys before persisting them or building aggregate keys. */
export function text(value: string, name: string, max: number = LIMITS.maxStringBytes) {
  if (typeof value !== "string" || !value || new TextEncoder().encode(value).length > max)
    throw new Error(`INVALID_${name}`);

  return value;
}

/** `max` is the per-charge cap for prices; callers that keep an over-cap
 * amount as OVER_CAP pass maxBilledNanos and compare against the cap. */
export function nanos(usd: number, max: number = LIMITS.maxChargeNanos) {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("INVALID_USD");

  return integer(Math.round(usd * LIMITS.nanosPerUsd), max, "NANOS");
}

/** Base events must use the raw charge key, so reserve the delta namespace. */
export function chargeKey(value: string) {
  text(value, "KEY", LIMITS.maxKeyBytes);

  if (value.includes(LIMITS.deltaSeparator)) throw new Error("RESERVED_CHARGE_KEY");

  return value;
}

/** Accept only named positive overrides within hard ceilings when the host registers meter. */
export function resolveLimits(overrides: Partial<ResolvedLimits> = {}): ResolvedLimits {
  for (const [key, value] of Object.entries(overrides)) {
    if (!overridable.includes(key)) throw new Error("INVALID_LIMIT");

    integer(value, LIMITS[key as keyof Limits], "LIMIT");

    if (!value) throw new Error("INVALID_LIMIT");
  }

  return {
    maxThreadCharges: LIMITS.maxThreadCharges,
    maxGroups: LIMITS.maxGroups,
    maxDays: LIMITS.maxDays,
    maxAttempts: LIMITS.maxAttempts,
    pruneMinAgeMs: LIMITS.pruneMinAgeMs,
    ...overrides,
  };
}
