export declare const jobs: import("convex/values").VObject<{
    deliver?: string | undefined;
    lookup?: string | undefined;
    maxAttempts: number;
}, {
    lookup: import("convex/values").VString<string | undefined, "optional">;
    deliver: import("convex/values").VString<string | undefined, "optional">;
    maxAttempts: import("convex/values").VFloat64<number, "required">;
}, "required", "maxAttempts" | "deliver" | "lookup">;
export declare const lookupJob: {
    key: import("convex/values").VString<string, "required">;
    provider: import("convex/values").VString<string, "required">;
    requestId: import("convex/values").VString<string, "required">;
    until: import("convex/values").VFloat64<number, "required">;
    attempt: import("convex/values").VFloat64<number, "required">;
    jobs: import("convex/values").VObject<{
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    }, {
        lookup: import("convex/values").VString<string | undefined, "optional">;
        deliver: import("convex/values").VString<string | undefined, "optional">;
        maxAttempts: import("convex/values").VFloat64<number, "required">;
    }, "required", "maxAttempts" | "deliver" | "lookup">;
};
/** One delivery job drains one sink's due outbox rows; `claim` names its batch. */
export declare const deliveryJob: {
    sink: import("convex/values").VString<string, "required">;
    claim: import("convex/values").VString<string, "required">;
    jobs: import("convex/values").VObject<{
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    }, {
        lookup: import("convex/values").VString<string | undefined, "optional">;
        deliver: import("convex/values").VString<string | undefined, "optional">;
        maxAttempts: import("convex/values").VFloat64<number, "required">;
    }, "required", "maxAttempts" | "deliver" | "lookup">;
};
