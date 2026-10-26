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
 * Every assignment has <=100 regular queued rows, one reserved answer slot,
 * and its reserved head (or approval continuation): I=A*102=1,632 ready rows.
 * Independently, <=24 passive notes per assignment add N=A*24=384 rows.
 * This deliberately overcounts: simultaneous child queues can belong to
 * DIFFERENT user-run budgets, so one run's 100 hops cannot bound the backlog.
 * Children only receive work from their fixed parentRunId; only the root
 * accepts new user requests. Across all queues there are therefore at most
 * U=100 root backlog + reserved head/answer/current +15 child budgets=118
 * distinct runs. Cancel deduplicates those ids before patching 16 KiB rows.
 * Retain the old per-ready-row run-patch count as conservative write headroom.
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
 * Bytes (KiB): inbox reads 2I=3,264; unique runs U*16=1,888;
 * assignment patch reads 4A*32=2,048; current runs A*16=256; scheduler 2A*4=128; child runs 2C*4=120;
 * ownership/final root 2*32=64; SDK allowance 64A*4=4,096;
 * passive metadata 2N=768; routing A*(16+16+32)=1,024.
 * Total <=13,656 KiB; staged continuations add <=1,040 KiB (turns/cancel.ts):
 * <=14,696 KiB <16,384 KiB, leaving 1,688 KiB read headroom.
 * Written bytes: run patches/inbox deletes <=U*16+I KiB, note deletes
 * <=N KiB, coordination <=4A*32+A*16+2A*4 KiB,
 * children <=C*4 KiB, final root <=32 KiB, SDK <=64A*4 KiB, and routing
 * <=A*(16+32) KiB: <=11,292 KiB <16 MiB.
 * Native messages (including each nearly
 * 1 MiB placeholder) are NEVER read by cancel; cleanup runs separately.
 * Subagent rows stay <=4 KiB: names/subjects/groups <=200 UTF-16 units,
 * hashed tool-call dedup keys, ids, counters and <=4 small events. Assignments
 * allow <=32 KiB: the original <=8 KiB (16 approval/deferred-call keys),
 * <=4 KiB exact message references, <=6 KiB side-review boundaries, two
 * prompt ids and scalar counters. The original 32 KiB
 * envelope remains conservative after removing the <=10 KiB control-id replay
 * list. Notes have their own bounded queue N; each raw row stays <=17 KiB
 * and is read only by separate per-assignment cleanup transactions (<864 KiB including ownership).
 * Saved control rows retain <=1 KiB of exact-id origin metadata and are excluded
 * from every ready/cancel index range. Runs carry a <=15 KiB settings map,
 * <=512-byte model map, scalar counters and two 64-bit start/routing masks.
 * newRun bounds the complete metadata at <=16 KiB, including native envelope.
 *
 * Other proportional paths: claim drains <=152 consecutive ready rows,
 * including <=50 ready joins from its run. Notes additionally read one exact
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
    readonly functionHandleLength: 1024;
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
    readonly contextBytes: number;
    readonly contextReadBytes: number;
    readonly maxDepth: 2;
    readonly messagesPerChild: 4;
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
    rootLane: import("convex/values").VFloat64<number, "required">;
    childLane: import("convex/values").VFloat64<number, "required">;
    runLaunches: import("convex/values").VFloat64<number, "required">;
    runHops: import("convex/values").VFloat64<number, "required">;
    activeChildrenPerRoot: import("convex/values").VFloat64<number, "required">;
    taskLength: import("convex/values").VFloat64<number, "required">;
    queueLength: import("convex/values").VFloat64<number, "required">;
    slicesPerTurn: import("convex/values").VFloat64<number, "required">;
    leaseMs: import("convex/values").VFloat64<number, "required">;
}, "required", "attachmentBytes" | "continuesPerRun" | "sideRunsPerRun" | "notesPending" | "maxDepth" | "messagesPerChild" | "rootLane" | "childLane" | "runLaunches" | "runHops" | "activeChildrenPerRoot" | "taskLength" | "queueLength" | "slicesPerTurn" | "leaseMs">;
export type Limits = {
    [K in keyof typeof limitsValidator.fields]: number;
};
/** Fail at registration, before any accepted prompt can launch background work. */
export declare function resolveLimits(overrides?: Partial<Limits>): Limits;
