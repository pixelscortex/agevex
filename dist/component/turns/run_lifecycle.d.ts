/** Root lifecycle snapshots survive later sends on the same assignment.
 * Closure uses exact request-scoped existence probes, never delegation history.
 */
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
/** One ready row <=1 KiB; passive notes and other user requests are excluded. */
export declare function readyForRun(ctx: QueryCtx, assignmentId: Id<"assignments">, runId: Id<"runs">): Promise<{
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
/** Transitive delivery fences, scoped to one request.
 * One probe <=4 KiB, plus <=1 KiB ready work.
 */
export declare function rootRunBlocked(ctx: QueryCtx, root: Doc<"assignments">, runId: Id<"runs">): Promise<boolean>;
/** Called after a root turn or blocker-clearing delivery. Recording
 * closure once makes history independent of later assignment status and clocks.
 * <=16 KiB run +17 KiB probes +16 KiB patch read, <64 KiB per invocation.
 */
export declare function closeRootRun(ctx: MutationCtx, root: Doc<"assignments">, runId?: import("convex/values").GenericId<"runs"> | undefined): Promise<void>;
/** The root's last turn outcome; only successful, unfenced runs close as done. */
export declare function endRootTurn(ctx: MutationCtx, row: Doc<"assignments">, errorCode: Doc<"assignments">["errorCode"]): Promise<void>;
