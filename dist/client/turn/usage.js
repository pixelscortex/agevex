import { noopMeter } from "../slots.js";
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
/** Wrap charge operations as well as creation: a late attach/settle failure must
 * not turn a successful paid tool into a retryable tool error. */
export function failOpenMeter(scope, failed) {
    const observe = async (work, fallback) => {
        try {
            return await work();
        }
        catch {
            await failed();
            return await fallback();
        }
    };
    const wrap = (charge) => ({
        key: charge.key,
        attach: (args) => observe(() => charge.attach(args), async () => undefined),
        correct: (args) => observe(() => charge.correct(args), async () => undefined),
        settle: (args) => observe(() => charge.settle(args), async () => undefined),
        get: () => observe(() => charge.get(), async () => null),
    });
    return {
        record: (provider, args) => observe(async () => wrap(await scope().record(provider, args)), () => noopMeter.record(provider, args)),
        estimate: (provider, args) => observe(async () => wrap(await scope().estimate(provider, args)), () => noopMeter.estimate(provider, args)),
    };
}
/** Every slice exit triggers an idempotent bounded sweep. This includes early
 * child completion and cancellation; no root-lifecycle inference is needed. */
export async function reconcileUsage(rt, turn) {
    try {
        await rt.config.usage?.reconcile?.(turn.rawCtx, {
            subject: turn.facts.subject,
            runId: turn.facts.runId,
        });
    }
    catch {
        // The recorded evidence remains complete if only scheduling fails.
        // A later slice or explicit reconciliation can schedule the same sweep.
    }
}
