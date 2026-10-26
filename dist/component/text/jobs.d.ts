/** Queue one non-retried child-lane job per kind/thread. No model work occurs
 * in foreground mutations; only bounded metadata and dispatch refs are written. */
import type { Doc, Id } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";
/** A capability is minted once; repeat deliveries can never reclaim a paid job. */
export declare function newTextJob(row: Doc<"assignments">, runId: Id<"runs">, kind: "title" | "summary"): {
    titleRef?: {
        id: string;
        order: number;
        stepOrder: number;
        bytes: number;
    } | undefined;
    key: `${string}-${string}-${string}-${string}-${string}`;
    runId: Id<"runs">;
    epoch: number;
    version: number;
    status: "queued";
};
/** Coalesce only live work. Unknown paid outcomes need a fresh explicit key;
 * a known failure permits the next cadence point to schedule new work. */
export declare function queueText(ctx: MutationCtx, row: Doc<"assignments">, kind: "title" | "summary", runId: Id<"runs">, explicit?: boolean): Promise<void>;
/** Cadence counts completed root turns, never tool slices or child turns.
 * Exact saved identity supplies the boundary without any transcript discovery. */
export declare function completeTextTurn(ctx: MutationCtx, row: Doc<"assignments">): Promise<void>;
