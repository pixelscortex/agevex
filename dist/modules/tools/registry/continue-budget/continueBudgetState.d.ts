/**
 * Record explicit consent. Call it from the host mutation that ALSO calls core
 * `respond({ approved: true })`, with the thread's current `activity.runId`, so
 * both commit or neither does. The run id binds the consent to the run that was
 * active when the user approved: an approval from one run can never unlock the
 * stop of another. Call it ONLY when `respond` returned `replayed: false`: a
 * replay means the approval was first decided earlier (maybe through plain core
 * `respond`, maybe in another run) and must never become consent now. As a
 * second guard, re-recording the same approval keeps the first row, spent or not.
 * subject/threadId/runId are core facts (<= 128 UTF-8 bytes); a row is < 2 KiB,
 * and unique() reads at most two rows (convex/src/server/impl/query_impl.ts:334-343).
 */
export declare const record: import("convex/server").RegisteredMutation<"internal", {
    runId: string;
    threadId: string;
    subject: string;
    approvalId: string;
}, Promise<null>>;
/**
 * Spend the consent: true exactly once, and only for this owner, thread,
 * approval AND the stopped run it was recorded for. Call it inside the resume
 * transaction (`resumeAfterBudgetStop` does): marking the row spent commits with
 * the budget raise, cancel and fresh send, and rolls back with them if any step
 * fails. A mismatching run leaves the row untouched, so it stays usable for its
 * own run. Single-use matters because one approval must not authorize every
 * later stop; the row is kept as `spent` (see `record`).
 */
export declare const consume: import("convex/server").RegisteredMutation<"internal", {
    runId: string;
    threadId: string;
    subject: string;
    approvalId: string;
}, Promise<boolean>>;
/**
 * Bounded host cleanup for one deleted thread. A replayed approve does not
 * record consent (the host's approve action checks `respond`'s `replayed`), but
 * spent rows stay as belt and braces for as long as core can still replay:
 * LIMITS.receiptRetentionMs (7 days) plus one LIMITS.purgeIntervalMs (1 hour)
 * plus a 1 hour margin, so a row younger than that is never deleted.
 * Deletes at most CONSENT_LIMITS.cleanupBatch rows (< 2 KiB each, < 256 KiB) of
 * that thread created before the cutoff, reading through the by_thread index's
 * _creationTime range so the read is bounded by the batch, and reports
 * `done: false` when more remain. Nothing reschedules itself.
 */
export declare const cleanup: import("convex/server").RegisteredMutation<"internal", {
    threadId: string;
    subject: string;
}, Promise<{
    deleted: number;
    done: boolean;
}>>;
