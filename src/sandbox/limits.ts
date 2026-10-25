/** All host-tunable bounds have hard ceilings; no provider input can lift them. */
export const LIMITS = {
  commandTimeoutS: 180,
  outputChars: 6_000,
  fileReadChars: 160_000,
  writeChars: 160_000,
  listEntries: 100,
  exportBytes: 25 * 1024 * 1024,
  exportChunkBytes: 512 * 1024,
  backgroundExecTimeoutS: 10,
  backgroundRoot: "/tmp/agevex/jobs",
  exportRoot: "/tmp/agevex/exports",
  ttl: 24 * 60 * 60 * 1000,
  pollMinMs: 1_000,
  pollMaxMs: 30_000,
  jobTimeoutMs: 60 * 60 * 1000,
  jobsPerSandbox: 16,
  cleanupBatch: 32,
  actionBudgetMs: 540_000,
  identityChars: 256,
  pathChars: 4096,
  commandChars: 16_000,
  providerChars: 64,
  scopeKeyChars: 64,
  claimChars: 64,
  handleChars: 1024,
  utf8BytesPerChar: 4,
  backoffFactor: 2,
  millisecondsPerSecond: 1000,
  daytonaAutoStopMinutes: 15,
  daytonaAutoArchiveMinutes: 10,
  daytonaTimerMaxMinutes: 525_600,
  daytonaReadyMs: 300_000,
  daytonaRequestMs: 30_000,
  disabledAutoDelete: -1,
  // Including Convex field names and system metadata, our validated sandbox
  // rows fit in 8 KiB and jobs in 64 KiB. These are conservative byte budgets,
  // not payload allowances. No command or file body is stored in either table.
  sandboxRowBytes: 8 * 1024,
  jobRowBytes: 64 * 1024,
} as const;

export type SandboxLimits =
  Pick<
    typeof LIMITS,
    | "commandTimeoutS"
    | "outputChars"
    | "fileReadChars"
    | "writeChars"
    | "listEntries"
    | "exportBytes"
    | "ttl"
    | "pollMinMs"
    | "pollMaxMs"
    | "jobTimeoutMs"
    | "jobsPerSandbox"
    | "cleanupBatch"
  > extends infer T
    ? { [K in keyof T]: number }
    : never;

export const HARD_LIMITS: SandboxLimits = {
  commandTimeoutS: LIMITS.commandTimeoutS,
  // stdout + stderr share this allowance: <=48 KiB UTF-8 plus metadata,
  // below core's 64 KiB receipt result ceiling even at the hard maximum.
  outputChars: 12_000,
  fileReadChars: 160_000,
  writeChars: 160_000,
  listEntries: 100,
  exportBytes: 100 * 1024 * 1024,
  ttl: 365 * 24 * 60 * 60 * 1000,
  pollMinMs: 120_000,
  pollMaxMs: 120_000,
  jobTimeoutMs: 24 * 60 * 60 * 1000,
  jobsPerSandbox: 64,
  cleanupBatch: 64,
};

/** Reject fractional, infinite, negative, zero and excessive host overrides. */
export function integer(value: number, maximum: number, name: string, minimum = 1) {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum)
    throw new Error(`SANDBOX_INVALID_${name}`);
  return value;
}

/** Bound strings before they can become component fields or provider inputs. */
export function bounded(value: string, maximum: number, name: string) {
  if (typeof value !== "string" || !value.length || value.length > maximum || value.includes("\0"))
    throw new Error(`SANDBOX_INVALID_${name}`);
  return value;
}

/** Validate at registration, before any potentially paid work is admitted. */
export function resolveLimits(overrides: Partial<SandboxLimits> = {}): SandboxLimits {
  for (const key of Object.keys(overrides))
    if (!Object.prototype.hasOwnProperty.call(HARD_LIMITS, key))
      throw new Error("SANDBOX_INVALID_LIMIT");
  const limits: SandboxLimits = { ...LIMITS, ...overrides };
  for (const key of Object.keys(HARD_LIMITS) as (keyof SandboxLimits)[])
    integer(limits[key], HARD_LIMITS[key], key);
  if (limits.pollMinMs > limits.pollMaxMs) throw new Error("SANDBOX_INVALID_POLL_RANGE");
  return Object.freeze(limits);
}

/** Keep the end of output, where command errors and completion messages live. */
export function tail(value: string, chars: number) {
  return value.slice(-chars);
}
