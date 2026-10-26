/**
 * Read-only projections of an `assignments` row for the host.
 *
 * `activityView` is the thread owner's public status (`turns.send.activity`);
 * `executionView` is the narrow execution metadata the host action polls
 * while it generates (`turns.slices.execution`); `assignmentScope` tells the client
 * whether a thread is a public root (`turns.send.assignment`). None of them
 * exposes context refs, approvals or recovery state.
 */
import { v } from "convex/values";
import { turnStatus as vTurnStatus } from "../schema.js";
/** The thread's public status, including its delegation counts. */
export function activityView(row) {
    return {
        assignmentId: row._id,
        threadId: row.threadId,
        agent: row.agent,
        assignmentStatus: "open",
        turnStatus: row.turnStatus,
        queuedMessages: row.queuedMessages,
        errorCode: row.errorCode,
        runId: row.runId,
        // Every reserved run is either live or settled, and settle/cancel move runs
        // one for one, so the history count follows from the two stored counters.
        subagents: {
            active: row.activeRuns,
            history: row.nextRunSequence - row.activeRuns,
            total: row.nextRunSequence,
        },
    };
}
/** The assignment's scope plus whether it is a public root. */
export function assignmentScope(row, threadId) {
    // The assignment's role is fixed by how it was created: a delegated child
    // carries its childRunId, while a public root does not. Never infer this from
    // the current registration's root names. A host could later promote a
    // former child agent name to a root; that must not promote its old child
    // threads or permit public sends outside the coordinator's lifecycle.
    // Keep this extra projection local to assignment so claim's execution
    // scope and its root/child turn payload remain unchanged.
    return {
        assignmentId: row._id,
        threadId,
        subject: row.subject,
        agent: row.agent,
        root: row.childRunId === undefined,
    };
}
/** Validator of `executionView`; each field names its reader. */
export const vExecution = v.object({
    // Read by runTurn to resolve the managed agent and its agent index.
    agent: v.string(),
    // Read by workflows.worker.dispatch: the host action that runs one slice.
    runTurn: v.string(),
    // Read by every client fence check alongside token and epoch.
    turnStatus: vTurnStatus,
    turnToken: v.optional(v.string()),
    cancellationEpoch: v.number(),
    cancelled: v.boolean(),
    // Read by runTurn: a paused turn never claims (Agent auto-denies otherwise).
    approvalBlocked: v.boolean(),
    // Read by usage capture to match the exact step saved by turns.slices.write.
    modelStep: v.optional(v.object({ messageId: v.string(), stepOrder: v.number() })),
    // Read by runTurn's bounded download of attached files.
    attachmentBytes: v.number(),
});
/** Read execution metadata outside the Workflow journal; only ids cross steps.
 * The host polls this during generation, so it returns only the fields its
 * readers use (workflows/worker.ts dispatch; in src/client/turn/, runTurn's
 * fence checks, cancel poll, usage capture and download bound), never the
 * context refs, approvals or recovery state of the whole row. */
export function executionView(row) {
    return {
        agent: row.agent,
        runTurn: row.runTurn,
        turnStatus: row.turnStatus,
        turnToken: row.turnToken,
        cancellationEpoch: row.cancellationEpoch,
        cancelled: row.cancelled,
        approvalBlocked: !!row.approvalBlocked,
        modelStep: row.modelStep,
        attachmentBytes: row.limits.attachmentBytes,
    };
}
