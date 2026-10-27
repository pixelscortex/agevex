import { type ObjectType } from "convex/values";
import { type MutationCtx, type QueryCtx } from "../_generated/server.js";
export declare const acceptArgs: {
    subject: import("convex/values").VString<string, "required">;
    agent: import("convex/values").VString<string, "required">;
    threadId: import("convex/values").VString<string, "required">;
    requestKey: import("convex/values").VString<string, "required">;
    fingerprint: import("convex/values").VString<string, "required">;
    promptMessageId: import("convex/values").VString<string, "required">;
    runTurn: import("convex/values").VString<string, "required">;
    limits: import("convex/values").VObject<{
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
    models: import("convex/values").VRecord<Record<string, string> | undefined, import("convex/values").VString<string, "required">, import("convex/values").VString<string, "required">, "optional", string>;
    settings: import("convex/values").VArray<{
        agent: string;
        settings: {
            askUser?: boolean | undefined;
            mode: "stream" | "generate";
            maxOutputTokens: number;
            modelTimeoutMs: number;
            toolTimeoutMs: number;
            stepsPerTurn: number;
        };
    }[] | undefined, import("convex/values").VObject<{
        agent: string;
        settings: {
            askUser?: boolean | undefined;
            mode: "stream" | "generate";
            maxOutputTokens: number;
            modelTimeoutMs: number;
            toolTimeoutMs: number;
            stepsPerTurn: number;
        };
    }, {
        agent: import("convex/values").VString<string, "required">;
        settings: import("convex/values").VObject<{
            askUser?: boolean | undefined;
            mode: "stream" | "generate";
            maxOutputTokens: number;
            modelTimeoutMs: number;
            toolTimeoutMs: number;
            stepsPerTurn: number;
        }, {
            askUser: import("convex/values").VBoolean<boolean | undefined, "optional">;
            mode: import("convex/values").VUnion<"stream" | "generate", [import("convex/values").VLiteral<"stream", "required">, import("convex/values").VLiteral<"generate", "required">], "required", never>;
            maxOutputTokens: import("convex/values").VFloat64<number, "required">;
            modelTimeoutMs: import("convex/values").VFloat64<number, "required">;
            toolTimeoutMs: import("convex/values").VFloat64<number, "required">;
            stepsPerTurn: import("convex/values").VFloat64<number, "required">;
        }, "required", "askUser" | "mode" | "maxOutputTokens" | "modelTimeoutMs" | "toolTimeoutMs" | "stepsPerTurn">;
    }, "required", "agent" | "settings" | "settings.askUser" | "settings.mode" | "settings.maxOutputTokens" | "settings.modelTimeoutMs" | "settings.toolTimeoutMs" | "settings.stepsPerTurn">, "optional">;
    textConfig: import("convex/values").VObject<{
        worker: string;
        updateThread: string;
        getThread: string;
    } | undefined, {
        worker: import("convex/values").VString<string, "required">;
        updateThread: import("convex/values").VString<string, "required">;
        getThread: import("convex/values").VString<string, "required">;
    }, "optional", "worker" | "updateThread" | "getThread">;
};
/** The typed duplicate/conflict receipt for an already accepted request, or
 * null for a new one. Shares the `request:<subject>` ledger scope. */
export declare function requestReceipt(ctx: Pick<QueryCtx, "db">, subject: string, requestKey: string, fingerprint: string): Promise<{
    status: "rejected";
    code: "KEY_CONFLICT";
} | {
    receiptId: import("convex/values").GenericId<"receipts">;
    status: "duplicate";
    assignmentId: string;
    threadId: string;
    position: number;
    code?: undefined;
} | null>;
/** Admit one host send; see the file header. Throws (rolling back the native
 * save) for a foreign thread, recovery_required or a full ready queue. */
export declare function acceptSend(ctx: MutationCtx, args: ObjectType<typeof acceptArgs>): Promise<{
    status: "rejected";
    code: "KEY_CONFLICT";
} | {
    receiptId: import("convex/values").GenericId<"receipts">;
    status: "duplicate";
    assignmentId: string;
    threadId: string;
    position: number;
    code?: undefined;
} | {
    assignmentId: import("convex/values").GenericId<"assignments">;
    threadId: string;
    receiptId: import("convex/values").GenericId<"receipts">;
    status: "accepted";
    position: number;
}>;
/**
 * Replay lookup after host authorization, before admission or native saves.
 * Use the host-authorized subject, never a supplied thread's stored owner:
 * even replay metadata must not reveal another subject's receipt. The exact
 * by_scope_key lookup uses unique() / take(2), so <=2 * 1 MiB are read even if
 * corrupt duplicate rows cause it to throw. No transcript or ledger scan.
 */
export declare const lookupReceipt: import("convex/server").RegisteredQuery<"public", {
    subject: string;
    fingerprint: string;
    requestKey: string;
}, Promise<{
    status: "rejected";
    code: "KEY_CONFLICT";
} | {
    receiptId: import("convex/values").GenericId<"receipts">;
    status: "duplicate";
    assignmentId: string;
    threadId: string;
    position: number;
    code?: undefined;
} | null>>;
/** Preflight shares the host mutation's snapshot with its later native save.
 * Expected refusal must happen before that save: returning a receipt after a
 * write would commit an orphan prompt rather than rolling the transaction back.
 */
export declare const admission: import("convex/server").RegisteredQuery<"public", {
    subject: string;
    threadId: string;
}, Promise<{
    status: "rejected";
    code: "CANCELLED" | "RECOVERY_REQUIRED";
} | {
    status: "rejected";
    code: "QUEUE_FULL";
} | null>>;
/** The thread's assignment scope and whether it is a public root. */
export declare const assignment: import("convex/server").RegisteredQuery<"public", {
    threadId: string;
}, Promise<{
    assignmentId: import("convex/values").GenericId<"assignments">;
    threadId: string;
    subject: string;
    agent: string;
    root: boolean;
} | null>>;
/** Admit one host send with its native prompt save; see `acceptSend`. */
export declare const accept: import("convex/server").RegisteredMutation<"public", {
    settings?: {
        agent: string;
        settings: {
            askUser?: boolean | undefined;
            mode: "stream" | "generate";
            maxOutputTokens: number;
            modelTimeoutMs: number;
            toolTimeoutMs: number;
            stepsPerTurn: number;
        };
    }[] | undefined;
    textConfig?: {
        worker: string;
        updateThread: string;
        getThread: string;
    } | undefined;
    models?: Record<string, string> | undefined;
    agent: string;
    limits: {
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
    };
    subject: string;
    threadId: string;
    runTurn: string;
    promptMessageId: string;
    fingerprint: string;
    requestKey: string;
}, Promise<{
    status: "rejected";
    code: "KEY_CONFLICT";
} | {
    receiptId: import("convex/values").GenericId<"receipts">;
    status: "duplicate";
    assignmentId: string;
    threadId: string;
    position: number;
    code?: undefined;
} | {
    assignmentId: import("convex/values").GenericId<"assignments">;
    threadId: string;
    receiptId: import("convex/values").GenericId<"receipts">;
    status: "accepted";
    position: number;
}>>;
/** The thread's public status for its owner. */
export declare const activity: import("convex/server").RegisteredQuery<"public", {
    subject: string;
    threadId: string;
}, Promise<{
    assignmentId: import("convex/values").GenericId<"assignments">;
    threadId: string;
    agent: string;
    assignmentStatus: "open";
    turnStatus: "idle" | "running" | "queued" | "recovery_required";
    queuedMessages: number;
    errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null;
    runId: import("convex/values").GenericId<"runs"> | undefined;
    subagents: {
        active: number;
        history: number;
        total: number;
    };
}>>;
