/** Hard ceilings keep row sizes, aggregate depth and action payloads predictable. */
export const LIMITS = {
  deltaSeparator: ":delta:",
  nanosPerUsd: 1_000_000_000,
  centsPerUsd: 100,
  aggregateNodeSize: 4,
  aggregateMaxDepth: 12,
  dayMs: 86_400_000,
  maxStringBytes: 128,
  maxKeyBytes: 256,
  maxChargeNanos: 10_000_000_000,
  maxQuantity: 1_000_000,
  maxCharges: 100_000,
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
  sinkBatch: 100,
  maxResponseBytes: 16_384,
  requestTimeoutMs: 30_000,
  maxTimestamp: 8_640_000_000_000_000,
} as const;

export type Limits = Pick<typeof LIMITS, "maxCharges" | "maxGroups" | "maxDays" | "maxAttempts">;
export type ResolvedLimits = { [K in keyof Limits]: number };

export function integer(value: number, max: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) throw new Error(`INVALID_${name}`);
  return value;
}

export function text(value: string, name: string, max: number = LIMITS.maxStringBytes) {
  if (!value || new TextEncoder().encode(value).length > max) throw new Error(`INVALID_${name}`);
  return value;
}

export function nanos(usd: number) {
  if (!Number.isFinite(usd) || usd < 0) throw new Error("INVALID_USD");
  return integer(Math.round(usd * LIMITS.nanosPerUsd), LIMITS.maxChargeNanos, "NANOS");
}

/** Base events must use the raw charge key, so reserve the delta namespace. */
export function chargeKey(value: string) {
  text(value, "KEY", LIMITS.maxKeyBytes);
  if (value.includes(LIMITS.deltaSeparator)) throw new Error("RESERVED_CHARGE_KEY");
  return value;
}

export function resolveLimits(overrides: Partial<ResolvedLimits> = {}): ResolvedLimits {
  for (const [key, value] of Object.entries(overrides)) {
    if (!["maxCharges", "maxGroups", "maxDays", "maxAttempts"].includes(key))
      throw new Error("INVALID_LIMIT");
    integer(value, LIMITS[key as keyof Limits], "LIMIT");
    if (!value) throw new Error("INVALID_LIMIT");
  }
  return {
    maxCharges: LIMITS.maxCharges,
    maxGroups: LIMITS.maxGroups,
    maxDays: LIMITS.maxDays,
    maxAttempts: LIMITS.maxAttempts,
    ...overrides,
  };
}
