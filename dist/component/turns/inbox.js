/** The oldest ready row of an assignment, or null. One indexed probe
 * (<=1 KiB of metadata for ready rows); passive notes are never in range. */
export function firstReady(ctx, assignmentId) {
    return ctx.db
        .query("inbox")
        .withIndex("by_assignment_ready", (q) => q.eq("assignmentId", assignmentId).eq("passive", undefined))
        .first();
}
/** Up to `limit` ready rows in FIFO order. Only cancel reads more than the
 * head; its caller passes the per-assignment bound from limits.ts. */
export function readyRows(ctx, assignmentId, limit) {
    return ctx.db
        .query("inbox")
        .withIndex("by_assignment_ready", (q) => q.eq("assignmentId", assignmentId).eq("passive", undefined))
        .take(limit);
}
