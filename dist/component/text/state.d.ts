export declare const snapshot: import("convex/values").VObject<{
    through?: {
        order: number;
        id: string;
        stepOrder: number;
        sequence: number;
    } | undefined;
    modelId?: string | undefined;
    agent: string;
    runId: import("convex/values").GenericId<"runs">;
    threadId: string;
    subject: string;
    refs: {
        order: number;
        bytes: number;
        id: string;
        stepOrder: number;
    }[];
    previous: string;
}, {
    subject: import("convex/values").VString<string, "required">;
    agent: import("convex/values").VString<string, "required">;
    threadId: import("convex/values").VString<string, "required">;
    runId: import("convex/values").VId<import("convex/values").GenericId<"runs">, "required">;
    modelId: import("convex/values").VString<string | undefined, "optional">;
    refs: import("convex/values").VArray<{
        order: number;
        bytes: number;
        id: string;
        stepOrder: number;
    }[], import("convex/values").VObject<{
        order: number;
        bytes: number;
        id: string;
        stepOrder: number;
    }, {
        id: import("convex/values").VString<string, "required">;
        order: import("convex/values").VFloat64<number, "required">;
        stepOrder: import("convex/values").VFloat64<number, "required">;
        bytes: import("convex/values").VFloat64<number, "required">;
    }, "required", "order" | "bytes" | "id" | "stepOrder">, "required">;
    previous: import("convex/values").VString<string, "required">;
    through: import("convex/values").VObject<{
        order: number;
        id: string;
        stepOrder: number;
        sequence: number;
    } | undefined, {
        id: import("convex/values").VString<string, "required">;
        order: import("convex/values").VFloat64<number, "required">;
        stepOrder: import("convex/values").VFloat64<number, "required">;
        sequence: import("convex/values").VFloat64<number, "required">;
    }, "optional", "order" | "id" | "stepOrder" | "sequence">;
}, "required", "agent" | "runId" | "through" | "through.order" | "through.id" | "through.stepOrder" | "through.sequence" | "threadId" | "subject" | "modelId" | "refs" | "previous">;
/** Cheap preflight before task preparation; dispatch repeats it atomically. */
export declare const active: import("convex/server").RegisteredQuery<"public", {
    kind: "title" | "summary";
    key: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<boolean>>;
/** Claim only preparation. Slow authorization or input reads cannot consume a
 * paid lease or turn a pre-dispatch cancellation into an unknown outcome. */
export declare const claim: import("convex/server").RegisteredMutation<"public", {
    kind: "title" | "summary";
    key: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<{
    subject: string;
    agent: string;
    threadId: string;
    runId: import("convex/values").GenericId<"runs">;
    modelId: string | undefined;
    refs: {
        id: string;
        order: number;
        stepOrder: number;
        bytes: number;
    }[];
    previous: string;
    through: {
        id: string;
        order: number;
        stepOrder: number;
        sequence: number;
    } | undefined;
} | null>>;
/** Final admission immediately before the provider's doGenerate call. A worker
 * crash after this transaction is the first point where a paid outcome can be
 * unknown. Duplicate/stale workers cannot start a second dispatch. */
export declare const dispatch: import("convex/server").RegisteredMutation<"public", {
    kind: "title" | "summary";
    key: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<boolean>>;
/** Timeout detection never schedules paid work. Only dispatched jobs can have
 * an unknown paid outcome; preparing/queued jobs remain retryable. */
export declare const expire: import("convex/server").RegisteredMutation<"internal", {
    kind: "title" | "summary";
    key: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<null>>;
/** Known failures can advance at the next cadence; unknown jobs need an
 * explicit fresh request key. No failed/unknown job itself is ever replayed. */
export declare const commit: import("convex/server").RegisteredMutation<"public", {
    text?: string | undefined;
    through?: {
        order: number;
        id: string;
        stepOrder: number;
        sequence: number;
    } | undefined;
    kind: "title" | "summary";
    status: "failed" | "done" | "unknown";
    key: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<boolean>>;
/** Bounded display metadata; summaries never alter native conversation context. */
export declare const view: import("convex/server").RegisteredQuery<"public", {
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<{
    version: number;
    source: "user" | "auto" | null;
    summary: {
        text: string;
        through: {
            order: number;
            id: string;
            stepOrder: number;
            sequence: number;
        };
    } | null;
}>>;
