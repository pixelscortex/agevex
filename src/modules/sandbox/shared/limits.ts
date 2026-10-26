/**
 * Pure bounds and validation shared by host and component sandbox code.
 * Registration checks overrides against hard maxima before admitting provider work.
 * Row, output and action budgets keep transactions and provider responses bounded.
 */
/** All host-tunable bounds have hard ceilings; no provider input can lift them. */
export const LIMITS = {
  commandTimeoutS: 180,
  outputChars: 6_000,
  // Core posts a completion as one passive note of at most 4,000 characters
  // ("Job <id>: <state> (exit n)\n" + log). 3,000 leaves room for that header,
  // so the tail kept here is never silently cut again downstream.
  completionLogChars: 3_000,
  // Core rejects an exit code above 2**31 - 1 in magnitude (and the rejection
  // would roll the job's settlement back), so larger values are not forwarded.
  completionExitCodeMax: 2 ** 31 - 1,
  fileReadChars: 160_000,
  writeChars: 160_000,
  listEntries: 100,
  exportBytes: 8 * 1024 * 1024,
  exportBytesNode: 64 * 1024 * 1024,
  exportChunkBytes: 512 * 1024,
  backgroundExecTimeoutS: 10,
  backgroundKillGraceS: 0.1,
  backgroundControlWaitS: 1,
  // Linux exec environments fit within ARG_MAX; overflow is unverified and
  // must skip fallback signaling rather than accepting a partial marker scan.
  backgroundEnvironmentBytes: 2 * 1024 * 1024,
  backgroundPublishPollS: 0.01,
  backgroundKillBudgetMs: 10_000,
  // Slack added after the kill budget when leasing a poll claim: the bounded
  // kill (10 s) plus the settle mutation must finish inside the claim, or the
  // watchdog wake would take the claim over and fail the settlement.
  backgroundLeaseMarginMs: 5_000,
  // Daytona kills the exec wrapper at its own timeout. The wrapper enforces
  // the command's timeout itself, so Daytona's is set this much later: the
  // wrapper must always get to kill the command's process group first.
  execKillMarginS: 5,
  // Marker-based kill (job directory gone): scan-and-kill passes before giving
  // up, and the pause that lets killed processes leave /proc between passes.
  // 3 * (scan + 0.05 s) stays far inside the 10 s kill budget.
  markerKillPasses: 3,
  markerKillPassPauseS: 0.05,
  // Claims made at or after the deadline that may die unsettled. The first
  // two still run the kill and notify path; the next one ends the job.
  lateAttemptsMax: 2,
  // A delete may take one Daytona request (30 s). Below this much remaining
  // action budget cleanup defers the row instead of claiming it, because a
  // claimed delete that times out is recorded as unknown.
  deleteMinBudgetMs: 30_000,
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
    | "exportBytesNode"
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
  exportBytes: LIMITS.exportBytes,
  exportBytesNode: LIMITS.exportBytesNode,
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
