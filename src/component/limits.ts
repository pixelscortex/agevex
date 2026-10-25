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
  continuesPerRun: { default: 3, max: 8 },
  sideRunsPerRun: { default: 2, max: 8 },
  notesPerTurn: { default: 8, max: 24 },
  maxDepth: { default: 2, max: 2 },
  messagesPerChild: { default: 4, max: 8 },
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
 * A = 1 root + 20 descendants = 21 assignments (depth never multiplies A).
 * Every assignment has <=100 regular queued rows, one reserved answer slot,
 * and its reserved head (or approval continuation). Use I=21*102=2,142 rows.
 * This deliberately overcounts: many simultaneous child queues belong to
 * DIFFERENT user-run budgets, so a single run's 100 hops is not a valid bound
 * on the whole root's backlog. Depth two allows each parent its own results.
 * Each inbox row costs one run patch and one inbox delete: 2I=4,284 writes.
 * Each assignment costs three patches, one current-run patch, two scheduler
 * cancels and one exact-id cleanup job: 7A=147. Add 20 child-run patches and
 * one final root patch. Reserve 64A=1,344 reads AND writes for Workflow's
 * current loop/turn, Workpool, scheduler and callback bookkeeping.
 * Writes <=2I+7A+20+1+64A=5,796 <8,000 <16,000.
 * Reads <=3I+4A+A+2A+2*20+2+64A=7,959 <8,192.
 * Bytes: inbox/run reads 3I*1 KiB; assignment patch reads 4A*32 KiB;
 * current runs A*1 KiB; scheduler 2A*4 KiB; child runs 40*4 KiB;
 * ownership/final root 2*32 KiB; SDK allowance 64A*4 KiB:
 * <=14,903 KiB <16 MiB. Native messages (including each nearly
 * 1 MiB placeholder) are NEVER read by cancel; cleanup runs separately.
 * Subagent rows stay <=4 KiB: names/subjects/groups <=200 UTF-16 units,
 * hashed tool-call dedup keys, ids, counters and <=4 small events. Assignments
 * allow <=32 KiB: the original <=8 KiB (16 approval/deferred-call keys),
 * <=4 KiB exact message references, <=8 KiB side-review boundaries, <=4 KiB
 * private hook error, plus scalar counters. Notes share the existing queue
 * bound and never multiply I. Run additions are scalar counters plus
 * two 64-bit start/routing masks, keeping each run within its <=1 KiB envelope.
 *
 * Other proportional paths: claim drains <=152 consecutive ready rows,
 * including <=50 ready joins from its run, and reads no native bodies. Each
 * join uses an indexed ready representative and <=20 cohort metadata rows;
 * admission/send/attach handle one item. Membership sealing reads/patches
 * <=50 launch rows. Descendant/settlement fences use indexed existence probes,
 * never historical prefixes. The tree reads <=50 model launches +8 side launches (232 KiB). Local comments
 * include combined claim/seal/release metadata allowances.
 * Native verification/delivery reads one exact <=1 MiB message, never the
 * launch history. Tasks are <=16,000 UTF-16 units (<=64 KiB UTF-8), with at
 * most one native task save per delegation. Hops/leases are scalar counters;
 * slices are separate Workflow steps. Launch/hop/slice maxima never multiply
 * native transcript sizes.
 */
export const LIMITS = {
  continuesPerRun: HOST_LIMITS.continuesPerRun.default,
  sideRunsPerRun: HOST_LIMITS.sideRunsPerRun.default,
  notesPerTurn: HOST_LIMITS.notesPerTurn.default,
  noteLength: 4_000,
  hookErrorLength: 1_000,
  agents: 64,
  sideAgents: 8,
  cadence: 1_000_000,
  minuteMs: 60_000,
  contextMessages: 24,
  assignmentBytes: 32 << 10,
  contextBytes: 48 << 10,
  contextReadBytes: 2 << 20,
  maxDepth: HOST_LIMITS.maxDepth.default,
  messagesPerChild: HOST_LIMITS.messagesPerChild.default,
  groupLength: 200,
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
  // Bound approval coordination metadata even when native approval ids are huge:
  // requests store SHA-256 keys; resolved contains only their array offsets.
  approvalsPerPause: 16,
  nativeCallIdLength: 1 << 20,
  nativeEnvelopeBytes: 4 << 10,
  // Separate read transactions, including Agent's SIX prefetched merge heads
  // (3 statuses * tool/non-tool; Agent src/component/messages.ts:809-845).
  // Messages: 0.5 MiB page + 1 MiB overshoot + 6*1 MiB heads + 0.25 MiB
  // coordination = 7.75 MiB <16 MiB. Count: <=100 page rows + six heads.
  // Stream deltas: 2*1 MiB metadata + 8 MiB native page + 1 MiB delta
  // overshoot + 0.25 MiB coordination = 11.25 MiB <16 MiB. Agent's fixed
  // 8 MiB page reads <=200 deltas (src/component/streams.ts:listDeltas).
  // streams.list retains the upstream 100-metadata-row exception (spec §9b).
  streamCursors: 2,
  // The public `messages` reader takes its page size from the client. Without a
  // server-side clamp, one request for a huge page of large tool results would
  // exceed the 16 MiB query read limit and that query would fail outright.
  // Native pagination stops early at `maximumBytesRead` and returns a cursor.
  // Agent owns the merged index lookahead and stream read bounds (spec §9b).
  messagePage: 100,
  messagePageBytes: 512 << 10,
  cleanupMessageBytes: 512 << 10,
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
  modelOverrides: 8,
  modelOverridesBytes: 512,
  modelIdLength: 200,
  modelAllowlist: 100,
} as const;

/** Only these policy bounds are tunable; internal safety/platform facts are not. */
export const limitsValidator = v.object({
  // Optional on persisted v1 assignments; resolveLimits always fills both for
  // new registrations. Missing legacy fields use the current safe defaults.
  continuesPerRun: v.optional(v.number()),
  sideRunsPerRun: v.optional(v.number()),
  notesPerTurn: v.optional(v.number()),
  maxDepth: v.optional(v.number()),
  messagesPerChild: v.optional(v.number()),
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
