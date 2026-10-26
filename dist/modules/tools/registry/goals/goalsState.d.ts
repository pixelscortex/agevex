/** Read only this owner/thread goal when goal_check runs; no transcript or history scan. */
export declare const check: import("convex/server").RegisteredQuery<"internal", {
    subject: string;
    threadId: string;
}, Promise<{
    goal: string | null;
}>>;
/** Validate and replace the thread goal atomically; the indexed read fences concurrent inserts. */
export declare const set: import("convex/server").RegisteredMutation<"internal", {
    subject: string;
    threadId: string;
    goal: string;
}, Promise<{
    goal: string;
}>>;
/**
 * Bounded host cleanup. Rows outlive their threads (the host owns retention), so
 * call this from your own thread-deletion or retention job. One call deletes at
 * most GOAL_LIMITS.cleanupBatch rows for the subject (optionally one thread) and
 * reports `done: false` when more remain, so the caller decides whether to call
 * again; nothing reschedules itself. Reads/deletes <= 128 rows of < 18 KiB =
 * < 2.3 MiB, 128 writes, one query: far below the 16 MiB / 16,000-write limits.
 */
export declare const cleanup: import("convex/server").RegisteredMutation<"internal", {
    threadId?: string | undefined;
    subject: string;
}, Promise<{
    deleted: number;
    done: boolean;
}>>;
