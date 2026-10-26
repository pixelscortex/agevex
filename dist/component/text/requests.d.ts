export declare const response: import("convex/values").VObject<{
    messageId: string;
    replayed: boolean;
}, {
    messageId: import("convex/values").VString<string, "required">;
    replayed: import("convex/values").VBoolean<boolean, "required">;
}, "required", "messageId" | "replayed">;
/** No native message is created by renaming. messageId is the native thread id
 * in the spec's shared response receipt; version is the idempotency fence. */
export declare const rename: import("convex/server").RegisteredMutation<"public", {
    text: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
    expectedVersion: number;
}, Promise<{
    messageId: string;
    replayed: boolean;
}>>;
/** Same key replays scheduling, including after a known failure. A fresh key
 * may request new work after failed or unknown outcomes; it never replays them. */
export declare const summarize: import("convex/server").RegisteredMutation<"public", {
    assignmentId: import("convex/values").GenericId<"assignments">;
    requestKey: string;
}, Promise<{
    status: "replayed";
} | {
    status: "queued";
}>>;
