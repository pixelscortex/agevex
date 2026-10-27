import { LIMITS } from "../limits.js";
import { getConvexSize } from "convex/values";
import { TREE_LIMITS } from "../run_tree_values.js";
/** The run with this public run id (unique `by_run` index), or null. */
export async function runById(ctx, runId) {
    return ctx.db
        .query("subagentRuns")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .unique();
}
/** True once a run reached a terminal status. Delivery may still be pending. */
export function isSettled(status) {
    return status === "completed" || status === "failed";
}
/** Append one transition, keeping only the newest `LIMITS.runEvents` so every
 * run row stays inside its <=4 KiB envelope (limits.ts cancel budget). Every
 * writer of `events` goes through here (reserve's first "queued" aside). */
export function appendEvent(events, phase, at, errorCode) {
    return [...events, { phase, at, errorCode }].slice(-LIMITS.runEvents);
}
const terminalPhases = new Set(["completed", "failed"]);
const deliveryPhases = new Set(["result_accepted", "delivery_failed", "delivery_blocked"]);
/** The public `finishedAt` / `deliveryAt` of a run, derived from its event
 * ring rather than stored a second time.
 *
 * Why the ring always holds both events: settleRunState and cancel are the
 * only terminal transitions and each refuses a run that is already terminal,
 * so a run has exactly one terminal event (completed/failed). Claim appends
 * "started" only while the run is queued or running, and applyDelivery
 * appends at most one delivery event, only to a terminal run whose delivery
 * is still pending. So at most one delivery event ever follows the terminal
 * event: both are among the newest two entries, inside the
 * `LIMITS.runEvents` (4) ring however many turns the child ran. Cancel marks
 * delivery `blocked` without a delivery event, in the same transaction as its
 * terminal event, so that event's time is also the delivery time. */
export function runTimes(run) {
    let finishedAt = null;
    let deliveryAt = null;
    for (const event of run.events) {
        if (terminalPhases.has(event.phase))
            finishedAt = event.at;
        if (deliveryPhases.has(event.phase))
            deliveryAt = event.at;
    }
    return {
        finishedAt,
        deliveryAt: deliveryAt ?? (run.deliveryStatus === "pending" ? null : finishedAt),
    };
}
/** The queued row reservation inserts before attaching the native child thread. */
export function newSubagentRun(fields) {
    const { request, actor, root, now } = fields;
    const row = {
        runId: fields.runId,
        // The root epoch this delegation belongs to; cancel bumps it to fence.
        rootCancellationEpoch: root.cancellationEpoch,
        depth: fields.depth,
        messagesReceived: 0,
        parentNotesSent: 0,
        // Budget, idempotency key and the root-wide reservation order.
        parentRunId: fields.budget._id,
        dedupKey: fields.dedupKey,
        sequence: fields.sequence,
        payloadFingerprint: request.payloadFingerprint,
        // Linkage: the root and the assignment whose turn launched this run.
        rootAssignmentId: root._id,
        actorAssignmentId: actor._id,
        agent: request.agent,
        actorAgent: actor.agent,
        // Lifecycle: queued until claim, pending delivery until settled+delivered.
        status: "queued",
        deliveryStatus: "pending",
        errorCode: null,
        // Delivery capability: the host coordinator proves it with this token.
        deliveryToken: crypto.randomUUID(),
        coordinateHandle: request.coordinateHandle,
        events: [{ phase: "queued", at: now, errorCode: null }],
    };
    assertRunMetadata(row);
    return row;
}
/** Leave 1 KiB for native id/time, future result/question refs, four events,
 * timestamps, note counters and the deferred last-turn outcome. Check again
 * at task attachment so native reference growth cannot break the 4 KiB read budget.
 */
export function assertRunMetadata(row) {
    if (Math.max(getConvexSize(row), new TextEncoder().encode(JSON.stringify(row)).byteLength) +
        TREE_LIMITS.childGrowthBytes >
        TREE_LIMITS.childBytes)
        throw new Error("RUN_METADATA_TOO_LARGE");
}
