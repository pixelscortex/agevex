/** Evidence failure containment. Paid outcomes never depend on usage-hook availability;
 * a sticky core marker keeps later reporting partial even after the hook recovers.
 */
import type { RuntimeContext } from "../registration/context.js";
import type { Turn } from "./context.js";
import type { TurnFence } from "./fence.js";
import type { SlotActionCtx, UsageEvent, UsageSlot } from "../slots.js";
import { LIMITS } from "../../component/limits.js";

/** Optional admission/deadline guard; standalone titles have only the hook bound. */
export type UsageDeliveryGuard = {
  signal?: AbortSignal;
  wait<T>(work: Promise<T>): Promise<T>;
  assertActive?: () => Promise<void>;
};

/** At most three host deliveries, never provider retries. Every retry checks
 * the authoritative fence (including this slice's native approval pause), and
 * ownership reads, hooks and backoff all race the live deadline.
 * If completion is already aborted, allow ONE bounded raw-context delivery of
 * incurred usage; no retry is admitted after revocation. Arbitrary host promises
 * cannot be cancelled, so an in-flight hook may still commit: apps MUST dedupe.
 * Hook/backoff budget: 3*1000 + 2*25 = 3050 ms, clipped by the turn fence.
 * Ownership reads use the existing fence; no recovery or wake-loop state is added. */
export async function deliverStepUsage(
  usage: UsageSlot,
  turn: Turn,
  fence: TurnFence,
  event: UsageEvent,
) {
  return deliverUsage(usage, turn.rawCtx, event, {
    signal: fence.controller.signal,
    wait: fence.wait,
    assertActive: () => fence.assertActive(true),
  });
}

/** Shared evidence-only retry loop for turns, titles and structured tasks.
 * The 3050 ms hook/backoff maximum applies without a guard; managed calls also
 * race the existing turn fence, including ownership reads before retries. */
export async function deliverUsage(
  usage: UsageSlot,
  ctx: SlotActionCtx,
  event: UsageEvent,
  guard?: UsageDeliveryGuard,
) {
  const wait = <T>(work: Promise<T>) => (guard ? guard.wait(work) : work);

  for (let attempt = 0; attempt < LIMITS.usageRecordAttempts; attempt++) {
    const alreadyAborted = guard?.signal?.aborted;

    try {
      if (attempt > 0 && guard?.assertActive) await wait(guard.assertActive());

      const pending = boundedUsageCall(() => usage.record(ctx, event));

      if (alreadyAborted) await pending;
      else await wait(pending);

      return;
    } catch (error) {
      if (guard?.signal?.aborted || attempt + 1 === LIMITS.usageRecordAttempts) throw error;

      await wait(new Promise<void>((resolve) => setTimeout(resolve, LIMITS.usageRecordBackoffMs)));
    }
  }
}

/** A host that never settles must not hold the action open indefinitely. */
export async function boundedUsageCall<T>(invoke: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      Promise.resolve().then(invoke),
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("USAGE_TIMEOUT")), LIMITS.usageRecordTimeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

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
