/** Internal only: callers must originate in core's authorized ToolContext. */
export declare const read: import("convex/server").RegisteredQuery<"internal", {
    subject: string;
    threadId: string;
}, Promise<{
    todos: {
        id: string;
        text: string;
        done: boolean;
    }[];
}>>;
/** Replace the bounded list inside core's fenced tool mutation; indexed lookup serializes first writes. */
export declare const write: import("convex/server").RegisteredMutation<"internal", {
    subject: string;
    threadId: string;
    todos: {
        id: string;
        done: boolean;
        text: string;
    }[];
}, Promise<{
    todos: {
        id: string;
        text: string;
        done: boolean;
    }[];
}>>;
/**
 * Bounded host cleanup. Rows outlive their threads (the host owns retention), so
 * call this from your own thread-deletion or retention job. One call deletes at
 * most TODO_LIMITS.cleanupBatch rows for the subject (optionally one thread) and
 * reports `done: false` when more remain, so the caller decides whether to call
 * again; nothing reschedules itself. Reads/deletes <= 128 rows of < 34 KiB =
 * < 4.3 MiB, 128 writes, one query: far below the 16 MiB / 16,000-write limits.
 */
export declare const cleanup: import("convex/server").RegisteredMutation<"internal", {
    threadId?: string | undefined;
    subject: string;
}, Promise<{
    deleted: number;
    done: boolean;
}>>;
