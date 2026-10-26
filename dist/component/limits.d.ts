/** Workflow 0.4.10 / Convex documented facts, not checked by this SDK.
 * Workflow enforces its journal/step byte ceilings; only ids and small control
 * values cross our steps. These platform facts are never host overrides.
 */
export declare const PLATFORM: {
    readonly journalBytes: number;
    readonly stepBytes: number;
    readonly nodeActionMs: number;
    readonly convexActionMs: number;
    readonly scheduledConcurrency: 8;
};
/** Host defaults and hard ceilings are paired so raising policy cannot unbound a transaction. */
export declare const HOST_LIMITS: {
    readonly attachmentBytes: {
        readonly default: number;
        readonly max: number;
    };
    readonly continuesPerRun: {
        readonly default: 3;
        readonly max: 8;
    };
    readonly sideRunsPerRun: {
        readonly default: 2;
        readonly max: 8;
    };
    readonly notesPending: {
        readonly default: 8;
        readonly max: 24;
    };
    readonly maxDepth: {
        readonly default: 2;
        readonly max: 2;
    };
    readonly messagesPerChild: {
        readonly default: 4;
        readonly max: 8;
    };
    readonly parentNotesPerChild: {
        readonly default: 4;
        readonly max: 8;
    };
    readonly rootLane: {
        readonly default: 2;
        readonly max: 4;
    };
    readonly childLane: {
        readonly default: 4;
        readonly max: 4;
    };
    readonly runLaunches: {
        readonly default: 12;
        readonly max: 50;
    };
    readonly runHops: {
        readonly default: 24;
        readonly max: 100;
    };
    readonly activeChildrenPerRoot: {
        readonly default: 5;
        readonly max: 15;
    };
    readonly taskLength: {
        readonly default: 4000;
        readonly max: 16000;
    };
    readonly queueLength: {
        readonly default: 20;
        readonly max: 100;
    };
    readonly slicesPerTurn: {
        readonly default: 16;
        readonly max: 64;
    };
    readonly leaseMs: {
        readonly default: number;
        readonly max: number;
    };
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
export declare const LIMITS: {
    readonly continuesPerRun: 3;
    readonly sideRunsPerRun: 2;
    readonly notesPending: 8;
    readonly noteLength: 4000;
    readonly firstPromptOrder: 1;
    readonly telemetryFlushMs: 3000;
    readonly filesPerMessage: 8;
    readonly factBytes: 128;
    readonly attachmentBytes: number;
    readonly fileIdLength: 200;
    readonly functionHandleBytes: 256;
    readonly nameLength: 200;
    readonly sandboxExitCode: number;
    readonly fileMetadataBytes: number;
    readonly taskRepairs: 1;
    readonly taskPromptLength: 16000;
    readonly agents: 64;
    readonly sideAgents: 8;
    readonly cadence: 1000000;
    readonly minuteMs: 60000;
    readonly contextMessages: 24;
    readonly assignmentBytes: number;
    readonly turnReportBytes: number;
    readonly messageIdBytes: 37;
    readonly contextBytes: number;
    readonly contextReadBytes: number;
    readonly maxDepth: 2;
    readonly messagesPerChild: 4;
    readonly parentNotesPerChild: 4;
    readonly parentNoteBytes: number;
    readonly parentNoteIntervalMs: 5000;
    readonly groupLength: 200;
    readonly rootLane: 2;
    readonly childLane: 4;
    readonly slicesPerTurn: 16;
    readonly turnsPerLoop: 50;
    readonly workflowVersion: 1;
    readonly cancelPollMs: 1000;
    readonly outputTokens: 4096;
    readonly runLaunches: 12;
    readonly runHops: 24;
    readonly activeChildrenPerRoot: 5;
    readonly taskLength: 4000;
    readonly queueLength: 20;
    readonly messageLength: 16000;
    readonly requestKeyLength: 200;
    readonly runEvents: 4;
    readonly maxDelegationPage: 50;
    readonly approvalsPerPause: 16;
    readonly nativeCallIdLength: number;
    readonly nativeEnvelopeBytes: number;
    readonly streamCursors: 2;
    readonly messagePage: 100;
    readonly messagePageBytes: number;
    readonly cleanupMessageBytes: number;
    readonly leaseMs: number;
    readonly receiptRetentionMs: number;
    readonly receiptResultBytes: number;
    readonly reconcileIntervalMs: 30000;
    readonly reconcileMaxIntervalMs: number;
    readonly purgeBatch: 50;
    readonly purgeIntervalMs: number;
    readonly streamThrottleMs: 0;
    readonly modelRetries: 0;
    readonly modelOverrides: 8;
    readonly modelOverridesBytes: 512;
    readonly modelIdLength: 200;
    readonly modelAllowlist: 100;
};
/** Only these policy bounds are tunable; internal safety/platform facts are not. */
export declare const limitsValidator: import("convex/values").VObject<{
    attachmentBytes: number;
    continuesPerRun: number;
    sideRunsPerRun: number;
    notesPending: number;
    maxDepth: number;
    messagesPerChild: number;
    parentNotesPerChild: number;
    rootLane: number;
    childLane: number;
    runLaunches: number;
    runHops: number;
    activeChildrenPerRoot: number;
    taskLength: number;
    queueLength: number;
    slicesPerTurn: number;
    leaseMs: number;
}, {
    attachmentBytes: import("convex/values").VFloat64<number, "required">;
    continuesPerRun: import("convex/values").VFloat64<number, "required">;
    sideRunsPerRun: import("convex/values").VFloat64<number, "required">;
    notesPending: import("convex/values").VFloat64<number, "required">;
    maxDepth: import("convex/values").VFloat64<number, "required">;
    messagesPerChild: import("convex/values").VFloat64<number, "required">;
    parentNotesPerChild: import("convex/values").VFloat64<number, "required">;
    rootLane: import("convex/values").VFloat64<number, "required">;
    childLane: import("convex/values").VFloat64<number, "required">;
    runLaunches: import("convex/values").VFloat64<number, "required">;
    runHops: import("convex/values").VFloat64<number, "required">;
    activeChildrenPerRoot: import("convex/values").VFloat64<number, "required">;
    taskLength: import("convex/values").VFloat64<number, "required">;
    queueLength: import("convex/values").VFloat64<number, "required">;
    slicesPerTurn: import("convex/values").VFloat64<number, "required">;
    leaseMs: import("convex/values").VFloat64<number, "required">;
}, "required", "attachmentBytes" | "continuesPerRun" | "sideRunsPerRun" | "notesPending" | "maxDepth" | "messagesPerChild" | "parentNotesPerChild" | "rootLane" | "childLane" | "runLaunches" | "runHops" | "activeChildrenPerRoot" | "taskLength" | "queueLength" | "slicesPerTurn" | "leaseMs">;
export type Limits = {
    [K in keyof typeof limitsValidator.fields]: number;
};
/** Message backlog + outstanding direct-child results + answer + reserved head
 * (or approval continuation). Launch bounds result work across request budgets;
 * joined rows replace members. The head is ready but excluded from queuedMessages.
 */
export declare function readyRowLimit(limits: Pick<Limits, "queueLength" | "runLaunches">): number;
/** Fail at registration, before any accepted prompt can launch background work. */
export declare function resolveLimits(overrides?: Partial<Limits>): Limits;
