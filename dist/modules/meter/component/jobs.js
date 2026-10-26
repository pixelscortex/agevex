/**
 * Workpool admission and retry bounds for read-only lookup and sink delivery.
 * Charge lifecycle and outbox helpers call these inside their own transaction.
 * The pool never retries an action implicitly; each on-demand delivery job has
 * a unique claim whose completion callback remains registered in charges.ts.
 */
import { Workpool } from "@convex-dev/workpool";
import { v } from "convex/values";
import { components, internal } from "./_generated/api.js";
import { jobs, deliveryJob } from "../shared/contracts.js";
import { LIMITS, integer, text } from "../shared/limits.js";
export const pool = new Workpool(components.workpool, { maxParallelism: LIMITS.maxParallelism });
/** Workpool's runtime supports function handles; its enqueueAction type only names references.
 * src/client/index.ts:576-579 passes a function:// handle through unchanged. */
export function actionHandle(handle) {
    return handle;
}
/** Validate retry ceilings and opaque worker handles before any charge or outbox work. */
export function validateJobs(config) {
    integer(config.maxAttempts, LIMITS.maxAttempts, "ATTEMPTS");
    if (!config.maxAttempts)
        throw new Error("INVALID_ATTEMPTS");
    // Function handles are opaque Convex strings, bounded separately from labels.
    for (const handle of [config.lookup, config.deliver])
        if (handle)
            text(handle, "HANDLE", LIMITS.maxKeyBytes);
}
/**
 * Start one delivery job for a sink. The job drains up to LIMITS.sinkBatch due
 * events of that sink, so a burst shares requests; jobs that find nothing
 * claimed return without contacting the sink. `claim` identifies the rows the
 * job takes, so its Workpool onComplete can count a crash as a failed attempt.
 * `crashes` counts consecutive deaths before claiming (see deliveryComplete).
 * onComplete also runs on success, to delete the job's claim marker.
 */
export async function enqueueDrain(ctx, sink, config, runAt, crashes = 0) {
    if (!config.deliver)
        return;
    const claim = crypto.randomUUID();
    await pool.enqueueAction(ctx, actionHandle(config.deliver), { sink, claim, jobs: config }, {
        retry: false,
        runAt,
        onComplete: internal.charges.deliveryComplete,
        context: { sink, claim, jobs: config, crashes },
    });
}
/** Bound the delay when a read-only lookup or sink attempt is retried. */
export function backoff(attempts) {
    return Math.min(LIMITS.maxBackoffMs, LIMITS.backoffMs * LIMITS.backoffBase ** attempts);
}
