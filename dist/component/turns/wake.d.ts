import type { MutationCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
/** Whether this child currently has an open question to its parent. An asking
 * child is paused (not stuck): nothing may claim or ring it until the answer
 * commits. Roots never ask. */
export declare function isAsking(ctx: MutationCtx, row: Doc<"assignments">): Promise<boolean>;
/**
 * Publish at most one ready inbox row and ring the thread's loop in the same
 * transaction as acceptance/delivery. Selection is metadata-only: claim keeps
 * deletion until after the host's native approval guard. The loop rechecks
 * this indexed queue after every child workflow, so early or duplicate events
 * can never create an extra model call. Its own reads use ring=false to avoid
 * waking itself forever when idle.
 */
export declare function wake(ctx: MutationCtx, row: Doc<"assignments">, ring?: boolean): Promise<void>;
/** The loop workflow's step: return the queued turn's token, or null after
 * recording that the loop now sleeps on its ping (`loopWaiting`). */
export declare function nextQueuedTurn(ctx: MutationCtx, assignmentId: Id<"assignments">): Promise<string | null>;
/**
 * Recovery lives outside the positional Workflow journal. A missing awaited
 * event can mean next's completion callback is still in flight, not that the
 * work was consumed. Keep checking through that transition with capped backoff.
 * Only Workflow's actual awaited ping permits a re-ring and a pinged reset;
 * this avoids another event/generation when resume is already in flight.
 * `recoveryAt` identifies the scheduled check; a superseded one is a no-op.
 */
export declare function reconcileDoorbell(ctx: MutationCtx, assignmentId: Id<"assignments">, recoveryAt: number | undefined): Promise<null>;
