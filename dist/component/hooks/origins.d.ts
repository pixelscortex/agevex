type Origin = {
    origin: "note" | "result";
    from?: string;
    runId?: string;
};
/** Label note and result messages on one reader page. */
export declare const origins: import("convex/server").RegisteredQuery<"public", {
    subject: string;
    messageIds: string[];
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<Record<string, Origin>>>;
export {};
