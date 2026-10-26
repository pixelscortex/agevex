export declare const TEXT_LIMITS: {
    readonly titleCharacters: 120;
    readonly titleBytes: 512;
    readonly summaryBytes: number;
    readonly inputBytes: number;
    readonly readBytes: number;
    readonly promptCharacters: number;
    readonly taskPromptCharacters: number;
    readonly timeoutMs: 30000;
    readonly leaseMs: 35000;
    readonly titleTokens: 128;
    readonly summaryTokens: 2048;
    readonly everyTurns: 1000000;
};
export declare const textKind: import("convex/values").VUnion<"title" | "summary", [import("convex/values").VLiteral<"title", "required">, import("convex/values").VLiteral<"summary", "required">], "required", never>;
export declare const textArgs: {
    assignmentId: import("convex/values").VString<string, "required">;
    kind: import("convex/values").VUnion<"title" | "summary", [import("convex/values").VLiteral<"title", "required">, import("convex/values").VLiteral<"summary", "required">], "required", never>;
    key: import("convex/values").VString<string, "required">;
};
export declare const textConfig: import("convex/values").VObject<{
    everyTurns?: number | undefined;
    worker: string;
    title: boolean;
    summary: boolean;
    updateThread: string;
    getThread: string;
}, {
    worker: import("convex/values").VString<string, "required">;
    updateThread: import("convex/values").VString<string, "required">;
    getThread: import("convex/values").VString<string, "required">;
    title: import("convex/values").VBoolean<boolean, "required">;
    summary: import("convex/values").VBoolean<boolean, "required">;
    everyTurns: import("convex/values").VFloat64<number | undefined, "optional">;
}, "required", "worker" | "title" | "summary" | "updateThread" | "getThread" | "everyTurns">;
export declare const textBoundary: import("convex/values").VObject<{
    order: number;
    id: string;
    stepOrder: number;
    sequence: number;
}, {
    id: import("convex/values").VString<string, "required">;
    order: import("convex/values").VFloat64<number, "required">;
    stepOrder: import("convex/values").VFloat64<number, "required">;
    sequence: import("convex/values").VFloat64<number, "required">;
}, "required", "order" | "id" | "stepOrder" | "sequence">;
export declare const textJob: import("convex/values").VObject<{
    dispatched?: boolean | undefined;
    again?: import("convex/values").GenericId<"runs"> | undefined;
    deferred?: boolean | undefined;
    titleRef?: {
        order: number;
        bytes: number;
        id: string;
        stepOrder: number;
    } | undefined;
    status: "failed" | "running" | "queued" | "done" | "unknown";
    key: string;
    runId: import("convex/values").GenericId<"runs">;
    epoch: number;
    version: number;
}, {
    key: import("convex/values").VString<string, "required">;
    runId: import("convex/values").VId<import("convex/values").GenericId<"runs">, "required">;
    epoch: import("convex/values").VFloat64<number, "required">;
    version: import("convex/values").VFloat64<number, "required">;
    status: import("convex/values").VUnion<"failed" | "running" | "queued" | "done" | "unknown", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"done", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"unknown", "required">], "required", never>;
    dispatched: import("convex/values").VBoolean<boolean | undefined, "optional">;
    again: import("convex/values").VId<import("convex/values").GenericId<"runs"> | undefined, "optional">;
    deferred: import("convex/values").VBoolean<boolean | undefined, "optional">;
    titleRef: import("convex/values").VObject<{
        order: number;
        bytes: number;
        id: string;
        stepOrder: number;
    } | undefined, {
        id: import("convex/values").VString<string, "required">;
        order: import("convex/values").VFloat64<number, "required">;
        stepOrder: import("convex/values").VFloat64<number, "required">;
        bytes: import("convex/values").VFloat64<number, "required">;
    }, "optional", "order" | "bytes" | "id" | "stepOrder">;
}, "required", "status" | "key" | "runId" | "epoch" | "version" | "dispatched" | "again" | "deferred" | "titleRef" | "titleRef.order" | "titleRef.bytes" | "titleRef.id" | "titleRef.stepOrder">;
export declare const storedSummary: import("convex/values").VObject<{
    text: string;
    through: {
        order: number;
        id: string;
        stepOrder: number;
        sequence: number;
    };
}, {
    text: import("convex/values").VString<string, "required">;
    through: import("convex/values").VObject<{
        order: number;
        id: string;
        stepOrder: number;
        sequence: number;
    }, {
        id: import("convex/values").VString<string, "required">;
        order: import("convex/values").VFloat64<number, "required">;
        stepOrder: import("convex/values").VFloat64<number, "required">;
        sequence: import("convex/values").VFloat64<number, "required">;
    }, "required", "order" | "id" | "stepOrder" | "sequence">;
}, "required", "text" | "through" | "through.order" | "through.id" | "through.stepOrder" | "through.sequence">;
/** Count encoded output as well as characters before either metadata store. */
export declare function validText(text: string, kind: "title" | "summary"): boolean;
