/** The assignment owning a native thread, via the unique `by_thread` index.
 * One indexed point read (<=16 KiB); used by every thread-addressed endpoint. */
export function assignmentByThread(ctx, threadId) {
    return ctx.db
        .query("assignments")
        .withIndex("by_thread", (q) => q.eq("threadId", threadId))
        .unique();
}
/** First row of a public root thread, created by `turns.send.accept` on its first
 * send. It carries no `childRunId`/`rootAssignmentId`: the absence of those
 * two fields is what makes it a root for its whole life. */
export function newRootAssignment(fields) {
    return {
        // Identity and the host action that runs each slice.
        subject: fields.subject,
        agent: fields.agent,
        threadId: fields.threadId,
        runTurn: fields.runTurn,
        limits: fields.limits,
        // No turn yet: wake reserves the first ready row.
        turnStatus: "idle",
        errorCode: null,
        // Inbox and turn counters start empty; accept increments them next.
        queuedMessages: 0,
        notesPending: 0,
        nextSequence: 0,
        nextTurn: 0,
        // Root-only delegation counters (activeRuns / ever-reserved runs).
        activeRuns: 0,
        nextRunSequence: 0,
        // Cancellation fence.
        cancellationEpoch: 0,
        cancelled: false,
    };
}
/** First row of a delegated child thread, created by `subagents.launch.attach` in the
 * same transaction as its first inbox row. The child inherits the root's
 * subject, host action and resolved limits, and runs under the parent's run
 * budget (`runId`), so its delegations spend the same launches and hops. Its
 * first prompt is already queued: `queuedMessages`/`nextSequence` start at 1. */
export function newChildAssignment(fields) {
    const { root, run } = fields;
    return {
        // Identity inherited from the root request.
        subject: root.subject,
        agent: run.agent,
        threadId: fields.childThreadId,
        runTurn: root.runTurn,
        limits: root.limits,
        turnStatus: "idle",
        errorCode: null,
        // The task prompt is the one queued row (sequence 0).
        queuedMessages: 1,
        notesPending: 0,
        nextSequence: 1,
        nextTurn: 0,
        // A child has its own epoch; the root's epoch is pinned on the run row.
        cancellationEpoch: 0,
        cancelled: false,
        activeRuns: 0,
        nextRunSequence: 0,
        // Linkage: root, shared run budget and the delegation that created it.
        rootAssignmentId: run.rootAssignmentId,
        runId: run.parentRunId,
        childRunId: run._id,
    };
}
