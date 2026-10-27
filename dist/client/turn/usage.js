import { LIMITS } from "../../component/limits.js";
/** At most three host deliveries, never provider retries. Every retry checks
 * the authoritative fence (including this slice's native approval pause), and
 * ownership reads, hooks and backoff all race the live deadline.
 * If completion is already aborted, allow ONE bounded raw-context delivery of
 * incurred usage; no retry is admitted after revocation. Arbitrary host promises
 * cannot be cancelled, so an in-flight hook may still commit: apps MUST dedupe.
 * Hook/backoff budget: 3*1000 + 2*25 = 3050 ms, clipped by the turn fence.
 * Ownership reads use the existing fence; no recovery or wake-loop state is added. */
export async function deliverStepUsage(usage, turn, fence, event) {
    for (let attempt = 0; attempt < LIMITS.usageRecordAttempts; attempt++) {
        const alreadyAborted = fence.controller.signal.aborted;
        try {
            if (attempt > 0)
                await fence.wait(fence.assertActive(true));
            const pending = boundedUsageCall(() => usage.record(turn.rawCtx, event));
            if (alreadyAborted)
                await pending;
            else
                await fence.wait(pending);
            return;
        }
        catch (error) {
            if (fence.controller.signal.aborted || attempt + 1 === LIMITS.usageRecordAttempts)
                throw error;
            await fence.wait(new Promise((resolve) => setTimeout(resolve, LIMITS.usageRecordBackoffMs)));
        }
    }
}
/** A host that never settles must not hold the action open indefinitely. */
export async function boundedUsageCall(invoke) {
    let timer;
    try {
        return await Promise.race([
            Promise.resolve().then(invoke),
            new Promise((_resolve, reject) => {
                timer = setTimeout(() => reject(new Error("USAGE_TIMEOUT")), LIMITS.usageRecordTimeoutMs);
            }),
        ]);
    }
    finally {
        clearTimeout(timer);
    }
}
/** Failure of the marker itself is best effort too, never a reason to repeat work. */
export async function markUsagePartial(rt, turn) {
    try {
        await turn.rawCtx.runMutation(rt.component.turns.slices.usageFailed, {
            runId: turn.facts.runId,
        });
    }
    catch {
        /* No evidence path may change the paid outcome. */
    }
}
