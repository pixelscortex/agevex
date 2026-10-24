/**
 * All runtime bounds live here. The two Workflow pools share the platform's
 * eight scheduled-action slots: two roots and four children leave room for
 * control jobs. Waiting workflows consume no action slot, and a root releases
 * its slot as soon as delegation is queued, so children can always progress.
 * Platform ceilings are documentation as well as a constraint on our defaults;
 * payloads stay in Agent storage rather than consuming the Workflow journal.
 */
import { v } from "convex/values";

/** Workflow 0.4.10 / Convex documented facts, not checked by this SDK.
 * Workflow enforces its journal/step byte ceilings; only ids and small control
 * values cross our steps. These platform facts are never host overrides.
 */
export const PLATFORM = {
  journalBytes: 8 << 20,
  stepBytes: 800 << 10,
  nodeActionMs: 10 * 60_000,
  convexActionMs: 30 * 60_000,
  scheduledConcurrency: 8,
} as const;

/** Host defaults and hard ceilings are paired so raising policy cannot unbound a transaction. */
export const HOST_LIMITS = {
  // Pool admission shares eight scheduled-action slots at both maxima together.
  rootLane: { default: 2, max: 4 },
  childLane: { default: 4, max: 4 },
  // Bound reservation/result admission and the number of child records per run.
  runLaunches: { default: 12, max: 50 },
  runHops: { default: 24, max: 100 },
  // Bound the assignments, run records and cleanup jobs fenced by one cancel.
  activeChildrenPerRoot: { default: 5, max: 20 },
  // Bound native task saves to <=64 KiB UTF-8 (plus its text projection).
  taskLength: { default: 4_000, max: 16_000 },
  // Bound cancel run patches/inbox deletes and claim result-batch reads/deletes.
  queueLength: { default: 20, max: 100 },
  // Bound the turn journal; cancel reads only its one in-progress step, not history.
  slicesPerTurn: { default: 16, max: 64 },
  // Ledger admission touches one receipt; cap its lease horizon to one day.
  leaseMs: { default: 10 * 60_000, max: 24 * 60 * 60_000 },
} as const;

/**
 * Cancel budget at ALL host maxima:
 * A = 1 root + 20 children = 21 assignments. The root has <=100 queued rows
 * plus one reserved head; each child has only its one attach-created prompt
 * (public sends and recursive delegation are forbidden): I = 101 + 20 = 121.
 * Each inbox row costs one run patch and one inbox delete: 2I = 242 writes.
 * Each assignment costs three assignment patches, one current-run patch, two
 * scheduler cancels and one exact-id cleanup job: 7A = 147. Add 20 child-run
 * patches and one final root patch. Workflow 0.4.10 cancel follows only the
 * current loop/turn step; reserve another 64 reads AND writes per assignment
 * for nested Workflow, Workpool, scheduler and callback bookkeeping: 64A=1,344.
 * Writes <= 2I + 7A + 20 + 1 + 64A = 1,754 < 8,000 < 16,000.
 * Reads include inbox query + delete read + run patch read (3I), assignments
 * and their three patch reads (4A), current runs (A), two scheduler jobs (2A),
 * child-run query + patch reads (2*20), final root patch and public ownership
 * read (2), plus SDK allowance (64A): <=1,896 < 4,096 < 8,192.
 * Budgeting 1 KiB per id-only inbox/run read and 4 KiB per other metadata read
 * gives 363 KiB + (1,896 - 363)*4 KiB < 8 MiB < 16 MiB. Native task/message
 * bodies (including 1 MiB pending placeholders) are never read here: each
 * recorded cleanup runs in its own later transaction.
 *
 * Other proportional paths: claim reads/deletes at most 101 inbox rows;
 * admission/send/reserve/attach/deliver handle one item, never the backlog or
 * launch history. Tasks are <=16,000 UTF-16 units (<=64 KiB UTF-8), with at
 * most one native task save per delegation. Hops/leases are scalar counters;
 * slices are separate Workflow steps. No transaction multiplies their maxima.
 */
export const LIMITS = {
  rootLane: HOST_LIMITS.rootLane.default,
  childLane: HOST_LIMITS.childLane.default,
  slicesPerTurn: HOST_LIMITS.slicesPerTurn.default,
  turnsPerLoop: 50,
  workflowVersion: 1,
  generationAbortMs: 90_000,
  executionWatchdogMs: 120_000,
  cancelPollMs: 1_000,
  outputTokens: 4096,
  runLaunches: HOST_LIMITS.runLaunches.default,
  runHops: HOST_LIMITS.runHops.default,
  activeChildrenPerRoot: HOST_LIMITS.activeChildrenPerRoot.default,
  taskLength: HOST_LIMITS.taskLength.default,
  queueLength: HOST_LIMITS.queueLength.default,
  messageLength: 16_000,
  requestKeyLength: 200,
  runEvents: 4,
  maxDelegationPage: 50,
  // One active generation per thread. The stream read shares 4 MiB between
  // <=1 MiB metadata, a 2 MiB delta page and <=1 MiB boundary overshoot.
  streamCursors: 1,
  streamPageBytes: 4 << 20,
  streamDeltaPage: 100,
  nativeDocumentBytes: 1 << 20,
  // The public `messages` reader takes its page size from the client. Without a
  // server-side clamp, one request for a huge page of large tool results would
  // exceed the 16 MiB query read limit and that query would fail outright.
  // Native pagination stops early at `maximumBytesRead` and returns a cursor.
  // Its six merged status/tool indexes can read <=6 additional <=1 MiB
  // lookahead/boundary documents. <=10 MiB plus the 4 MiB stream budget leaves
  // room for assignment/authorization metadata under Convex's 16 MiB ceiling.
  messagePage: 100,
  messagePageBytes: 4 << 20,
  leaseMs: HOST_LIMITS.leaseMs.default,
  receiptRetentionMs: 7 * 24 * 60 * 60_000,
  receiptResultBytes: 64 << 10,
  reconcileIntervalMs: 30_000,
  reconcileMaxIntervalMs: 5 * 60_000,
  // Query + delete reads + the continuation probe: (2*50+1)*64 KiB
  // = 6.3125 MiB for results, leaving >1 MiB for receipt metadata under 8 MiB.
  purgeBatch: 50,
  purgeIntervalMs: 60 * 60_000,
  streamThrottleMs: 0,
  modelRetries: 0,
} as const;

/** Only these policy bounds are tunable; internal safety/platform facts are not. */
export const limitsValidator = v.object({
  rootLane: v.number(),
  childLane: v.number(),
  runLaunches: v.number(),
  runHops: v.number(),
  activeChildrenPerRoot: v.number(),
  taskLength: v.number(),
  queueLength: v.number(),
  slicesPerTurn: v.number(),
  leaseMs: v.number(),
});
export type Limits = { [K in keyof typeof limitsValidator.fields]: number };

/** Fail at registration, before any accepted prompt can launch background work. */
export function resolveLimits(overrides: Partial<Limits> = {}): Limits {
  for (const [key, value] of Object.entries(overrides)) {
    if (
      !Object.prototype.hasOwnProperty.call(limitsValidator.fields, key) ||
      !Number.isSafeInteger(value) ||
      value <= 0
    )
      throw new Error("INVALID_LIMITS: expected positive integer host bounds");
    const maximum = HOST_LIMITS[key as keyof Limits].max;
    if (value > maximum) throw new Error(`INVALID_LIMITS: ${key} exceeds maximum ${maximum}`);
  }
  const merged = Object.fromEntries(
    Object.keys(limitsValidator.fields).map((key) => [
      key,
      overrides[key as keyof Limits] ?? LIMITS[key as keyof Limits],
    ]),
  ) as Limits;
  if (merged.rootLane + merged.childLane > PLATFORM.scheduledConcurrency)
    throw new Error("INVALID_LIMITS: lanes exceed scheduled concurrency");
  return merged;
}
