/** Evidence failure containment. Paid outcomes never depend on meter availability;
 * a sticky core marker keeps later reporting partial even after the meter recovers.
 */
import type { MeterBackend, MeterChargeBackend } from "../slots.js";
import { noopMeter } from "../slots.js";
import type { RuntimeContext } from "../registration/context.js";
import type { Turn } from "./context.js";

/** Failure of the marker itself is best effort too, never a reason to repeat work. */
export async function markUsagePartial(rt: RuntimeContext, turn: Turn) {
  try {
    await turn.rawCtx.runMutation(rt.component.turns.slices.usageFailed, {
      runId: turn.facts.runId,
    });
  } catch {
    /* No evidence path may change the paid outcome. */
  }
}

/** Wrap charge operations as well as creation: a late attach/settle failure must
 * not turn a successful paid tool into a retryable tool error. */
export function failOpenMeter(
  scope: () => MeterBackend,
  failed: () => Promise<void>,
): MeterBackend {
  const observe = async <T>(work: () => Promise<T>, fallback: () => Promise<T>) => {
    try {
      return await work();
    } catch {
      await failed();

      return await fallback();
    }
  };

  const wrap = (charge: MeterChargeBackend): MeterChargeBackend => ({
    key: charge.key,
    attach: (args) =>
      observe(
        () => charge.attach(args),
        async () => undefined,
      ),
    correct: (args) =>
      observe(
        () => charge.correct(args),
        async () => undefined,
      ),
    settle: (args) =>
      observe(
        () => charge.settle(args),
        async () => undefined,
      ),
    get: () =>
      observe(
        () => charge.get(),
        async () => null,
      ),
  });

  return {
    record: (provider, args) =>
      observe(
        async () => wrap(await scope().record(provider, args)),
        () => noopMeter.record(provider, args),
      ),
    estimate: (provider, args) =>
      observe(
        async () => wrap(await scope().estimate(provider, args)),
        () => noopMeter.estimate(provider, args),
      ),
  };
}

/** Every slice exit triggers an idempotent bounded sweep. This includes early
 * child completion and cancellation; no root-lifecycle inference is needed. */
export async function reconcileUsage(rt: RuntimeContext, turn: Turn) {
  try {
    await rt.config.usage?.reconcile?.(turn.rawCtx, {
      subject: turn.facts.subject,
      runId: turn.facts.runId,
    });
  } catch {
    await markUsagePartial(rt, turn);
  }
}
