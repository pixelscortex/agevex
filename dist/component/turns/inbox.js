/** The oldest ready row of an assignment, or null. One indexed probe
 * (<=1 KiB of metadata for ready rows); passive notes are never in range. */
export function firstReady(ctx, assignmentId) {
    return ctx.db
        .query("inbox")
        .withIndex("by_assignment_ready", (q) => q.eq("assignmentId", assignmentId).eq("passive", undefined))
        .first();
}
/** Up to `limit` ready rows in FIFO order. Cancel and launch admission pass
 * the per-assignment readyRowLimit from limits.ts; native bodies stay elsewhere. */
export function readyRows(ctx, assignmentId, limit) {
    return ctx.db
        .query("inbox")
        .withIndex("by_assignment_ready", (q) => q.eq("assignmentId", assignmentId).eq("passive", undefined))
        .take(limit);
}
