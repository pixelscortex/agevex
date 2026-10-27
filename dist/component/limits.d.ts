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
 * C=15 live descendants; A=1+C=16 assignments. Depth never multiplies A.
 * I=A*(100 queued prompts +50 outstanding direct-child results +2 head/answer)
 * =2,432 ready rows. Launch admission counts pending deliveries and ready
 * results across request budgets; delivery cannot be blocked by user backlog.
 * N=A*24=384 passive notes are cleaned by finite separate jobs, never read here.
 * U=100 root messages +50 result budgets +3 head/answer/current +15 child
 * budgets=168 distinct runs. Cancel deduplicates these before guard/patch.
 * SDK bookkeeping reserves 64A=1,024 reads/writes at <=3 KiB read/4 KiB write
 * per row (Workflow 0.4.10 workflow.ts:350-455; Workpool 0.4.14 lib.ts:137-259).
 * Every assignment has one state patch, current-run patch, two scheduler
 * cancels and one exact-id cleanup job; retain conservative old row allowances.
 * Writes <=2I+N+5A+C+1+64A=6,368 <16,000.
 * Reads <=3I+2N+5A+2C+2+64A+U=9,368 <32,000.
 * Indexed queries <=3 child-status ranges +A inbox ranges +64A=1,043 <4,096.
 * Bytes read (KiB): ready scan/delete 2I=4,864; run guard/patch 2U*16=5,376;
 * assignments 2A*14=448; scheduler 2A*4=128; children 2C*4=120;
 * final root 2*14=28; SDK 64A*3=3,072; cleanup jobs A*4=64.
 * Total <=14,100 KiB <16,384 KiB, leaving 2,284 KiB headroom.
 * Bytes written (KiB): U*16+I+N+2A*14+A*16+2A*4+C*4+16+64A*4
 * =10,508 KiB <16 MiB. No staged hook continuation or routing locks remain.
 * Native messages/placeholders are NEVER read by cancel; cleanup is separate.
 *
 * Assignment envelope is 14 KiB, including native/system fields. The all-fields
 * fixture tests/save-bounds.fixture.ts fills every remaining writer bound:
 * approvals <=4,802 B; report <=2,635 B; metadata handles <=806 B;
 * pending generation <=988 B; runTurn <=258 B; names <=1,204 B;
 * model map <=510 B; limits <=309 B; remaining fields/names/overhead <=1,064 B.
 * Total <=12,576 B; 14,336-12,576=1,760 B headroom at every writer cap.
 * No summary body, context ring, review history, cadence or text job is stored.
 * activeTools is excluded from save growth: write clears it first, and the
 * progress writer separately refuses a marker crossing assignmentBytes.
 * Raw note rows <=17 KiB, read only by bounded per-assignment jobs.
 * Saved controls <=1 KiB carry exact origins and are excluded from ready ranges.
 * Run metadata stays <=16 KiB including <=15 KiB settings and <=512 B models.
 *
 * Claim consumes <=152 ready rows and <=24 notes. It reads only exact native
 * anchors plus Agent's bounded merge heads, never history for control decisions.
 * Combined note/native/coordination reads stay <13 MiB at host maxima (fixture
 * tests/claim-bounds.test.ts). Native result verification reads one <=1 MiB
 * message; task <=16,000 UTF-16 units, at most one native save per delegation.
 * The run tree reads <=50 launch rows <=4 KiB each (200 KiB).
 */
export declare const LIMITS: {
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
    readonly assignmentBytes: number;
    readonly turnReportBytes: number;
    readonly messageIdBytes: 37;
    readonly maxDepth: 2;
    readonly messagesPerChild: 4;
    readonly parentNotesPerChild: 4;
    readonly parentNoteBytes: number;
    readonly parentNoteIntervalMs: 5000;
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
}, "required", "attachmentBytes" | "notesPending" | "maxDepth" | "messagesPerChild" | "parentNotesPerChild" | "rootLane" | "childLane" | "runLaunches" | "runHops" | "activeChildrenPerRoot" | "taskLength" | "queueLength" | "slicesPerTurn" | "leaseMs">;
export type Limits = {
    [K in keyof typeof limitsValidator.fields]: number;
};
/** Message backlog + outstanding direct-child results + answer + reserved head
 * (or approval continuation). Launch bounds result work across request budgets;
 * Each result occupies its own row. The head is ready but excluded from queuedMessages.
 */
export declare function readyRowLimit(limits: Pick<Limits, "queueLength" | "runLaunches">): number;
/** Fail at registration, before any accepted prompt can launch background work. */
export declare function resolveLimits(overrides?: Partial<Limits>): Limits;
