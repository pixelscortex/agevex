/**
 * Message origins for the public thread reader (`origins`).
 *
 * The reader shows a page of native messages; for each id it asks whether the
 * message was a note (with its sender) or a delivered child result (with its
 * run id). Both answers
 * come from exact-id indexes (`inbox.by_message`,
 * `subagentRuns.by_result_message`) scoped to the page, never history.
 */
import { type QueryCtx } from "../_generated/server.js";
import type { Id } from "../_generated/dataModel.js";
type Origin = {
    origin: "note" | "result";
    from?: string;
    runId?: string;
};
/** Page-local indexed lookups: <=100 controls *1 KiB +100 results *4 KiB
 * +16 KiB ownership =516 KiB, <=201 documents and <=201 index queries.
 * Control rows with a native id never retain bodies; no history prefix is read.
 * Only rows belonging to this subject's assignment are reported.
 */
export declare function messageOrigins(ctx: QueryCtx, args: {
    assignmentId: Id<"assignments">;
    subject: string;
    messageIds: string[];
}): Promise<Record<string, Origin>>;
/** Label note and result messages on one reader page. */
export declare const origins: import("convex/server").RegisteredQuery<"public", {
    subject: string;
    messageIds: string[];
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<Record<string, Origin>>>;
export {};
