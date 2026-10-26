/**
 * Approval pauses: when a model step asks for tool approval (or calls a
 * declared no-execute "deferred" tool the host must answer), the turn stops
 * and waits for `turns.approvals.respond` / `turns.approvals.answer`.
 *
 * All of it runs inside `turns.slices.write`, in the same transaction as the native
 * assistant save that contains the requests: count them against
 * `LIMITS.approvalsPerPause` before the save, retire requests whose results
 * the save carries, collect the new requests as fixed-size hashes, and
 * suspend the turn with one continuation inbox row. Touches
 * `assignments.approvals`/`approvalBlocked` and `inbox`.
 */
import type { MessageDoc } from "@convex-dev/agent";
import type { MutationCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
type PauseRequest = NonNullable<Doc<"assignments">["approvals"]>["requests"][number];
/** The requests one native save opened, the first message that holds one, and
 * the raw count (duplicates included) that decides whether the turn pauses. */
export type Pause = {
    requests: PauseRequest[];
    count: number;
    requestMessageId?: string;
};
/** Decided approvals still need native results from continuation generation. */
export declare function awaitingApprovalResults(row: Doc<"assignments">): boolean;
/** How many approval requests and deferred calls a pending save would open.
 * Pure: write checks it BEFORE the native save so an overflow never exists. */
export declare function countPauseRequests(messages: {
    message?: MessageDoc["message"];
}[], deferredTools: Set<string>): number;
/** Retire recorded requests this save consumed: a tool result for the call,
 * or (for a resolved provider-executed request) any successful assistant
 * response. Mutates `row.approvals` so later steps see the remainder. */
export declare function retireConsumedApprovals(ctx: MutationCtx, row: Doc<"assignments">, messages: MessageDoc[]): Promise<void>;
/** Collect the approval requests, then the deferred calls, that a native save
 * opened. Pure apart from hashing; throws if a deferred call's id/name could
 * not fit in one bounded cancellation cleanup document. */
export declare function collectPause(messages: MessageDoc[], deferredTools: Set<string>): Promise<Pause>;
/** Suspend the running turn on the requests just recorded: close the slice,
 * insert the continuation row at the head of the ready FIFO, and commit
 * `approvalBlocked` with the request hashes and native handles. */
export declare function suspendForApprovals(ctx: MutationCtx, row: Doc<"assignments">, pause: Pause, handles: {
    getMessages: string;
    addMessages: string;
}): Promise<void>;
export {};
