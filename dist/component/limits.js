/**
 * All runtime bounds live here. The two Workflow pools share the platform's
 * eight scheduled-action slots: two roots and four children leave room for
 * control jobs. Waiting workflows consume no action slot, and a root releases
 * its slot as soon as delegation is queued, so children can always progress.
 * Platform ceilings are documentation as well as a constraint on our defaults;
 * payloads stay in Agent storage rather than consuming the Workflow journal.
 * Contents: PLATFORM facts, HOST_LIMITS (defaults + hard maxima a host may
 * override), the full cancel budget arithmetic, LIMITS (fixed bounds) and
 * `resolveLimits`, which the client calls at registration. A resolved copy is
 * stored on every assignment row (`row.limits`).
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
};
/** Host defaults and hard ceilings are paired so raising policy cannot unbound a transaction. */
export const HOST_LIMITS = {
    // Shared message admission and generation download budget, including history.
    attachmentBytes: { default: 8 << 20, max: 16 << 20 },
    continuesPerRun: { default: 3, max: 8 },
    sideRunsPerRun: { default: 2, max: 8 },
    // The single note admission cap is independent of the ready-work queue.
    notesPending: { default: 8, max: 24 },
    maxDepth: { default: 2, max: 2 },
    messagesPerChild: { default: 4, max: 8 },
    parentNotesPerChild: { default: 4, max: 8 },
    // Pool admission shares eight scheduled-action slots at both maxima together.
    rootLane: { default: 2, max: 4 },
    childLane: { default: 4, max: 4 },
    // Bound launches per run and outstanding result work per assignment across runs.
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
};
/**
 * Cancel budget at ALL host maxima:
 * C = 15 descendants; A = 1 root + C = 16 assignments (depth never multiplies A).
 * Every assignment has <=100 message rows +50 direct-child result rows,
 * one answer and its reserved head (or approval continuation):
 * I=A*(100+50+2)=2,432 ready rows. Launch admission bounds outstanding
 * result work across user budgets: pending deliveries +unreleased join members
 * +ready result rows <=50. Joined rows replace members; delivery never needs
 * queue capacity. Only launch increases that total, and claim decreases it.
 * Independently, <=24 passive notes per assignment add N=A*24=384 rows.
 * This deliberately overcounts: simultaneous child queues can belong to
 * DIFFERENT user-run budgets, so one run's 100 hops cannot bound the backlog.
 * Children only receive work from their fixed parentRunId; only the root
 * accepts new user requests. Across all queues there are therefore at most
 * U=100 root messages +50 result budgets +head/answer/current +15 child budgets=168
 * distinct runs. Cancel deduplicates those ids before reading and conditionally
 * patching 16 KiB rows; a terminal run is never rewritten.
 * Retain the old per-ready-row run-patch count as conservative write headroom.
 * Passive note bodies and retained control rows are NEVER read by cancel.
 * One finite cleanup job per assignment handles <=24 raw notes separately.
 * Keep the old 2N metadata/delete document allowance below as conservative
 * headroom; byte accounting instead reserves <=A cleanup jobs (<=4 KiB each).
 * Each assignment costs one combined state patch, one current-run patch,
 * two scheduler cancels and one exact-id cleanup job: 5A=80. Add C child-run patches and
 * one final root patch. Reserve 64A=1,024 reads AND writes for Workflow's
 * current loop/turn, Workpool, scheduler and callback bookkeeping.
 * Managed SDK records carry only ids/handles and small control outcomes (no
 * messages): <=3 KiB each. Workflow 0.4.10 workflow.ts:350-455 reads only each
 * loop/turn's in-progress step; Workpool 0.4.14 lib.ts:137-150,238-259 reads
 * globals/work/pending-cancel and pings the worker. The 64A doc allowance is
 * retained; current-run reads/patches are already included in the unique U.
 * Collect routing ownership masks during the assignment loop, then clear
 * their union in the existing unique-run guard/patch. No separate routing
 * reads/writes remain, including when several owners share one run.
 * Cancel clears watchdog/recovery/routing ownership in one assignment patch.
 * Writes <=2I+N+5A+C+1+64A=6,368 <8,000 <16,000.
 * Reads <=3I+2N+4A+A+2C+2+64A+U=9,368 <32,000.
 * Indexed queries <=3 child-status ranges +A inbox ranges +64A SDK allowance
 * =1,043 <4,096; point reads above do not execute indexed range queries.
 * Bytes (KiB): inbox reads 2I=4,864; unique run guard+patch 2U*16=5,376;
 * assignment read/patch 2A*34=1,088; scheduler 2A*4=128; child runs 2C*4=120;
 * ownership/final root 2*34=68; SDK allowance 64A*3=3,072;
 * cleanup jobs A*4=64. Base <=14,780 KiB; staged continuations add
 * <=1,040 KiB (turns/cancel.ts): <=15,820 KiB <16,384 KiB,
 * leaving 564 KiB read headroom. This saves 512 KiB of separate routing reads.
 * Written bytes: run patches/inbox deletes <=U*16+I KiB, note deletes
 * <=N KiB, coordination <=2A*34+A*16+2A*4 KiB,
 * children <=C*4 KiB, final root <=34 KiB, SDK <=64A*4 KiB:
 * <=11,166 KiB, plus <=1,040 KiB staged-continuation deletion allowance
 * =12,206 KiB <16 MiB. Routing writes are folded into the run patches.
 * Native messages (including each nearly
 * 1 MiB placeholder) are NEVER read by cancel; cleanup runs separately.
 * Subagent rows stay <=4 KiB: names/subjects/groups <=200 UTF-16 units,
 * hashed tool-call dedup keys, ids, counters and <=4 small events. Assignments
 * allow <=34 KiB (34,816 bytes). The largest row the writer bounds admit, with
 * EVERY field at its cap (tests/save-bounds.test.ts, Convex bytes including
 * system fields and field names), is 29,810 bytes:
 *   textSummary <=8 KiB text + boundary                         8,303
 *   reviewed: 8 side agents, 200-unit (<=600-byte) names        5,234
 *   approvals: 16 SHA-256 keys/ids/proposals + 2 handles        4,802
 *   contextMessages: 24 exact refs                              2,666
 *   turnReport: 64*37-byte ids + prompt/cap/resume (3 KiB cap)  2,635
 *   handles <=256 B: pendingGeneration (3) 988, textConfig (3) 842,
 *     runTurn 258; approvals' two are counted above            2,088
 *   subject + agent: <=200 UTF-16 units each                    1,204
 *   title/summary jobs 592, models <=512 B 510, limits 358      1,460
 *   remaining ids, scalars, literals and object overhead        1,418
 * leaving 5,006 bytes (~4.9 KiB) of headroom. Names and handles are bounded
 * where they enter (facts.ts: send, reserve, markReviewed and every native
 * write), so this sum never depends on host string lengths. activeTools is
 * excluded: write clears it before a save grows the row, and its own writer
 * (turns/tools.ts) refuses a marker that would cross the envelope.
 * Notes have their own bounded queue N; each raw row stays <=17 KiB and is
 * read only by separate per-assignment cleanup transactions (<=850 KiB
 * including ownership).
 * Saved control rows retain <=1 KiB of exact-id origin metadata and are excluded
 * from every ready/cancel index range. Runs carry a <=15 KiB settings map,
 * <=512-byte model map, scalar counters and two 64-bit start/routing masks.
 * newRun bounds the complete metadata at <=16 KiB, including native envelope.
 *
 * Other proportional paths: claim drains <=152 consecutive ready rows,
 * including <=50 owed result rows/joins from its run. Notes additionally read one exact
 * anchor and one native merge-head batch (hooks/notes.ts); no history is scanned. Each
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
    telemetryFlushMs: 3_000,
    filesPerMessage: 8,
    factBytes: 128,
    attachmentBytes: HOST_LIMITS.attachmentBytes.default,
    fileIdLength: 200,
    // Every function handle we store (runTurn, textConfig, pendingGeneration,
    // approvals, subagent coordinators, attachment natives), in UTF-8 bytes.
    // Convex 1.47 serializes a handle as `function://<id>#<udf path>`
    // (crates/common/src/bootstrap_model/components/handles.rs:83-90): an 11-byte
    // prefix, a <=37-byte base32 document id (value/src/id_v6.rs:35-49) and the
    // advisory path, e.g. `messages.js:addMessages`. Real agevex/Agent handles are
    // ~60-100 bytes, so 256 leaves 2.5x margin while keeping the nine handles an
    // assignment may hold to <=2.25 KiB of its envelope.
    functionHandleBytes: 256,
    // Subjects and agent names stored on assignments (and agent names on side
    // review entries). The host client already narrows both to 128 UTF-8 bytes
    // (facts.ts); the component bounds its own writers independently.
    nameLength: 200,
    sandboxExitCode: 2 ** 31 - 1,
    fileMetadataBytes: 4 << 10,
    taskRepairs: 1,
    taskPromptLength: 16_000,
    agents: 64,
    sideAgents: 8,
    cadence: 1_000_000,
    minuteMs: 60_000,
    contextMessages: 24,
    assignmentBytes: 34 << 10,
    turnReportBytes: 3 << 10,
    messageIdBytes: 37,
    contextBytes: 48 << 10,
    contextReadBytes: 2 << 20,
    maxDepth: HOST_LIMITS.maxDepth.default,
    messagesPerChild: HOST_LIMITS.messagesPerChild.default,
    parentNotesPerChild: HOST_LIMITS.parentNotesPerChild.default,
    parentNoteBytes: 2 << 10,
    parentNoteIntervalMs: 5_000,
    groupLength: 200,
    rootLane: HOST_LIMITS.rootLane.default,
    childLane: HOST_LIMITS.childLane.default,
    slicesPerTurn: HOST_LIMITS.slicesPerTurn.default,
    turnsPerLoop: 50,
    workflowVersion: 1,
    cancelPollMs: 1_000,
    outputTokens: 4096,
    runLaunches: HOST_LIMITS.runLaunches.default,
    runHops: HOST_LIMITS.runHops.default,
    activeChildrenPerRoot: HOST_LIMITS.activeChildrenPerRoot.default,
    taskLength: HOST_LIMITS.taskLength.default,
    queueLength: HOST_LIMITS.queueLength.default,
    messageLength: 16_000,
    requestKeyLength: 200,
    // At least 2: subagents/runs.ts `runTimes` reads the terminal and delivery
    // events, which are always the newest two entries of the ring.
    runEvents: 4,
    maxDelegationPage: 50,
    // Bound approval coordination metadata even when native approval ids are huge:
    // requests store SHA-256 keys and a per-request resolved flag, never payloads.
    approvalsPerPause: 16,
    nativeCallIdLength: 1 << 20,
    nativeEnvelopeBytes: 4 << 10,
    // Separate read transactions, including Agent's SIX prefetched merge heads
    // (3 statuses * tool/non-tool; Agent src/component/messages.ts:809-845).
    // Messages: 0.5 MiB page + 1 MiB overshoot + 6*1 MiB heads + 0.25 MiB
    // coordination = 7.75 MiB <16 MiB. Count: <=100 page rows + six heads.
    // Origin lookup adds <=100*1 KiB controls +100*4 KiB results +34 KiB
    // ownership =534 KiB and <=201 reads/queries; combined <8.28 MiB <16 MiB.
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
};
/** Only these policy bounds are tunable; internal safety/platform facts are not. */
export const limitsValidator = v.object({
    // resolveLimits fills every policy field at registration, so a stored row
    // always carries the complete resolved set and readers never fall back.
    attachmentBytes: v.number(),
    continuesPerRun: v.number(),
    sideRunsPerRun: v.number(),
    notesPending: v.number(),
    maxDepth: v.number(),
    messagesPerChild: v.number(),
    parentNotesPerChild: v.number(),
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
/** Message backlog + outstanding direct-child results + answer + reserved head
 * (or approval continuation). Launch bounds result work across request budgets;
 * joined rows replace members. The head is ready but excluded from queuedMessages.
 */
export function readyRowLimit(limits) {
    return limits.queueLength + limits.runLaunches + 2;
}
/** Fail at registration, before any accepted prompt can launch background work. */
export function resolveLimits(overrides = {}) {
    for (const [key, value] of Object.entries(overrides)) {
        if (!Object.prototype.hasOwnProperty.call(limitsValidator.fields, key) ||
            !Number.isSafeInteger(value) ||
            value <= 0)
            throw new Error("INVALID_LIMITS: expected positive integer host bounds");
        const maximum = HOST_LIMITS[key].max;
        if (value > maximum)
            throw new Error(`INVALID_LIMITS: ${key} exceeds maximum ${maximum}`);
    }
    const merged = Object.fromEntries(Object.keys(limitsValidator.fields).map((key) => [
        key,
        overrides[key] ?? LIMITS[key],
    ]));
    if (merged.rootLane + merged.childLane > PLATFORM.scheduledConcurrency)
        throw new Error("INVALID_LIMITS: lanes exceed scheduled concurrency");
    return merged;
}
