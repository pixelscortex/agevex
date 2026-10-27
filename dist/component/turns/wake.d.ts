import type { MutationCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
/** A question pauses child admission until its answer commits. */
export declare function isAsking(ctx: MutationCtx, row: Doc<"assignments">): Promise<boolean>;
/** Publish claimable work in the producer's transaction. Never create a new
 * event here: only the loop's empty-queue transaction owns event creation.
 * Re-read after reservation so event delivery sees the committed turn token.
 */
export declare function wake(ctx: MutationCtx, row: Doc<"assignments">): Promise<void>;
/** Retire only queue metadata belonging to an ambiguous, terminal root
 * request. Native results remain in history; note origins remain addressable.
 * This also fences late deliveries after an unrelated request has resumed.
 * <=152 ready rows (1 KiB each) and <=152 exact run reads (16 KiB each),
 * memoized by run, plus <=152 patch/delete reads. No native bodies are read.
 */
export declare function firstClaimable(ctx: MutationCtx, row: Doc<"assignments">): Promise<{
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
type CapturedTurn = {
    executionId: string;
    epoch: number;
};
export type NextTurn = CapturedTurn | {
    failure: CapturedTurn;
} | {
    wakeEventId: string;
} | null;
/** Atomically reserve work or create the exact event this loop must await.
 * Old loops stop cooperatively after cancel, including when cancellation
 * races the gap between this mutation and awaitEvent registration. That lets
 * every created event enter the journal before SDK cleanup deletes it.
 */
export declare function nextQueuedTurn(ctx: MutationCtx, assignmentId: Id<"assignments">, workflowId: string): Promise<NextTurn>;
export {};
