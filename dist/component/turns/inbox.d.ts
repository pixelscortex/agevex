/**
 * The shared ready-range reads of the `inbox` table.
 *
 * An assignment's inbox is its FIFO of ready work (user prompts, delivered
 * results, parent follow-ups, questions, approval continuations) plus passive
 * note bodies and retained control ids. Ready rows are exactly the rows with
 * `passive: undefined` in `by_assignment_ready`, in `sequence` order. Every
 * "is there work?" probe (wake, recovery, claim, settlement fence, approval
 * pause, cancel) reads this one range, so they can never disagree about what
 * counts as pending work. Inserts stay at their call sites: each is a short,
 * kind-specific literal.
 */
import type { QueryCtx } from "../_generated/server.js";
import type { Id } from "../_generated/dataModel.js";
/** The oldest ready row of an assignment, or null. One indexed probe
 * (<=1 KiB of metadata for ready rows); passive notes are never in range. */
export declare function firstReady(ctx: Pick<QueryCtx, "db">, assignmentId: Id<"assignments">): Promise<{
    _id: import("convex/values").GenericId<"inbox">;
    _creationTime: number;
    from?: string | undefined;
    passive?: boolean | undefined;
    text?: string | undefined;
    noteEpoch?: number | undefined;
    kind: "result" | "user" | "parent" | "note";
    messageId: string;
    runId: import("convex/values").GenericId<"runs">;
    assignmentId: import("convex/values").GenericId<"assignments">;
    sequence: number;
} | null>;
/** Up to `limit` ready rows in FIFO order. Cancel and launch admission pass
 * the per-assignment readyRowLimit from limits.ts; native bodies stay elsewhere. */
export declare function readyRows(ctx: Pick<QueryCtx, "db">, assignmentId: Id<"assignments">, limit: number): Promise<{
    _id: import("convex/values").GenericId<"inbox">;
    _creationTime: number;
    from?: string | undefined;
    passive?: boolean | undefined;
    text?: string | undefined;
    noteEpoch?: number | undefined;
    kind: "result" | "user" | "parent" | "note";
    messageId: string;
    runId: import("convex/values").GenericId<"runs">;
    assignmentId: import("convex/values").GenericId<"assignments">;
    sequence: number;
}[]>;
