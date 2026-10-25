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
  // The single note admission cap is independent of the ready-work queue.
  notesPending: { default: 8, max: 24 },
  maxDepth: { default: 2, max: 2 },
  messagesPerChild: { default: 4, max: 8 },
  // Pool admission shares eight scheduled-action slots at both maxima together.
  rootLane: { default: 2, max: 4 },
  childLane: { default: 4, max: 4 },
  // Bound reservation/result admission and the number of child records per run.
  runLaunches: { default: 12, max: 50 },
  runHops: { default: 24, max: 100 },
  // Bound the assignments, run records and cleanup jobs fenced by one cancel.
  activeChildrenPerRoot: { default: 5, max: 15 },
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
 * C = 15 descendants; A = 1 root + C = 16 assignments (depth never multiplies A).
 * Every assignment has <=100 regular queued rows, one reserved answer slot,
 * and its reserved head (or approval continuation): I=A*102=1,632 ready rows.
 * Independently, <=24 passive notes per assignment add N=A*24=384 rows.
 * This deliberately overcounts: simultaneous child queues can belong to
 * DIFFERENT user-run budgets, so one run's 100 hops cannot bound the backlog.
 * Each ready row costs one run patch and one inbox delete: 2I=3,264 writes.
 * Passive note bodies and retained control rows are NEVER read by cancel.
 * One finite cleanup job per assignment handles <=24 raw notes separately.
 * Keep the old 2N metadata/delete allowance below as conservative headroom;
 * it also covers the extra <=A cleanup jobs (<=4 KiB each).
 * Each assignment costs three patches, one current-run patch, two scheduler
 * cancels and one exact-id cleanup job: 7A=112. Add C child-run patches and
 * one final root patch. Reserve 64A=1,024 reads AND writes for Workflow's
 * current loop/turn, Workpool, scheduler and callback bookkeeping.
 * Routing settlement adds two writes and THREE reads per owner: get the run,
 * read it again to patch it, and read the assignment again to clear ownership.
 * Writes <=2I+N+9A+C+1+64A=4,832 <8,000 <16,000.
 * Reads <=3I+2N+6A+A+3A+2C+2+64A=6,980 <32,000.
 * Indexed queries <=3 child-status ranges +A inbox ranges +64A SDK allowance
 * =1,043 <4,096; point reads above do not execute indexed range queries.
 * Bytes (KiB): inbox/run reads 3I=4,896; assignment patch reads 4A*32=2,048;
 * current runs A=16; scheduler 2A*4=128; child runs 2C*4=120;
 * ownership/final root 2*32=64; SDK allowance 64A*4=4,096;
 * passive metadata 2N=768; routing A*(1+1+32)=544.
 * Total <=12,680 KiB <16,384 KiB: 3,704 KiB /22.6% read headroom.
 * Written bytes are also bounded by these envelopes: ready run patches/inbox
 * deletes <=2I KiB, note deletes <=N KiB, coordination <=4A*32+A+2A*4 KiB,
 * children <=C*4 KiB, final root <=32 KiB, SDK <=64A*4 KiB, and routing
 * <=A*(1+32) KiB: <=10,556 KiB <16 MiB.
 * Native messages (including each nearly
 * 1 MiB placeholder) are NEVER read by cancel; cleanup runs separately.
 * Subagent rows stay <=4 KiB: names/subjects/groups <=200 UTF-16 units,
 * hashed tool-call dedup keys, ids, counters and <=4 small events. Assignments
 * allow <=32 KiB: the original <=8 KiB (16 approval/deferred-call keys),
 * <=4 KiB exact message references, <=6 KiB side-review boundaries, <=3 KiB
 * private hook error, two prompt ids and scalar counters. The original 32 KiB
 * envelope remains conservative after removing the <=10 KiB control-id replay
 * list. Notes have their own bounded queue N; each raw row stays <=17 KiB
 * and is read only by separate per-assignment cleanup transactions (<864 KiB including ownership).
 * Saved control rows retain <=1 KiB of exact-id origin metadata and are excluded
 * from every ready/cancel index range. Run additions are scalar counters plus
 * two 64-bit start/routing masks, keeping each run within its <=1 KiB envelope.
 *
 * Other proportional paths: claim drains <=152 consecutive ready rows,
 * including <=50 ready joins from its run. Notes additionally read one exact
 * anchor and one native merge-head batch (hooks.ts); no history is scanned. Each
 * join uses an indexed ready representative and <=15 cohort metadata rows;
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
  notesPending: HOST_LIMITS.notesPending.default,
  noteLength: 4_000,
  firstPromptOrder: 1,
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
  // Origin lookup adds <=100*1 KiB controls +100*4 KiB results +32 KiB
  // ownership =532 KiB and <=201 reads/queries; combined <8.27 MiB <16 MiB.
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
  notesPending: v.number(),
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
