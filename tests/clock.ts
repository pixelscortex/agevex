/** Drive fake scheduler time only inside Convex actions, after imports settle. */
import { vi } from "vite-plus/test";

const CLOCK_LIMITS = { steps: 3_000, tickMs: 100 } as const;

type Scheduler = { action: (handler: () => Promise<void>) => Promise<unknown> };

/**
 * expect.poll advances fake timers between retries outside the Convex action
 * context. Fence callbacks can then lose their backend and abort healthy turns.
 * Settle lazy modules before each tick so transform/I/O speed cannot consume a
 * simulated deadline. A zero tick waits for work without spending phase time.
 */
export async function advanceUntil(
  t: Scheduler,
  check: () => boolean | Promise<boolean>,
  tickMs: number = CLOCK_LIMITS.tickMs,
) {
  for (let step = 0; step < CLOCK_LIMITS.steps; step++) {
    await vi.dynamicImportSettled();

    await t.action(async () => {
      await vi.advanceTimersByTimeAsync(tickMs);
    });

    if (await check()) return;
  }

  throw new Error("Scheduled work did not reach its checkpoint");
}
