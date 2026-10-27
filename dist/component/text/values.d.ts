export declare const TEXT_LIMITS: {
    readonly titleCharacters: 120;
    readonly titleBytes: 512;
    readonly inputBytes: number;
    readonly promptCharacters: number;
    readonly taskPromptCharacters: number;
    readonly timeoutMs: 30000;
    readonly leaseMs: 35000;
    readonly titleTokens: 128;
};
export declare const textKind: import("convex/values").VLiteral<"title", "required">;
export declare const textArgs: {
    assignmentId: import("convex/values").VString<string, "required">;
    kind: import("convex/values").VLiteral<"title", "required">;
    key: import("convex/values").VString<string, "required">;
};
export declare const textConfig: import("convex/values").VObject<{
    worker: string;
    updateThread: string;
    getThread: string;
}, {
    worker: import("convex/values").VString<string, "required">;
    updateThread: import("convex/values").VString<string, "required">;
    getThread: import("convex/values").VString<string, "required">;
}, "required", "worker" | "updateThread" | "getThread">;
/** Count encoded output as well as characters before updating native metadata. */
export declare function validText(text: string, _kind: "title"): boolean;
