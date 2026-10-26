/**
 * Bound charge handles used after estimate and inline recording.
 * Every operation validates and authorizes before calling the component.
 * Stable operation keys are passed through unchanged for receipt replay;
 * the component remains the authority for state transitions and idempotency.
 */
import { LIMITS, integer, nanos, text } from "../shared/limits.js";
import { jobs } from "./configuration.js";
import { costNanos, lookupMs } from "./pricing.js";
import type { ChargeHandle, Provider } from "./types.js";
import type { MeterBinding } from "./scope.js";

/** `provider` is undefined for an unregistered name: the charge exists as
 * `unknown`, and only a USD settlement can resolve it. */
export function chargeHandle(
  { meter, ctx, guard }: MeterBinding,
  key: string,
  provider: Provider | undefined,
): ChargeHandle {
  const { component } = meter;

  return {
    key,
    get: async () => {
      await guard();

      return await ctx.runQuery(component.charges.get, { key });
    },
    attach: async ({ requestId, key: operationKey }) => {
      text(operationKey, "OPERATION_KEY", LIMITS.maxKeyBytes);
      await guard();

      return await ctx.runMutation(component.charges.attach, {
        key,
        requestId,
        operationKey,
        lookupMs: lookupMs(provider ?? {}),
        jobs: { ...(await jobs(meter)), ...(!provider?.lookup ? { lookup: undefined } : {}) },
      });
    },
    correct: async ({ quantity, key: operationKey }) => {
      text(operationKey, "OPERATION_KEY", LIMITS.maxKeyBytes);
      await guard();
      integer(quantity, LIMITS.maxQuantity, "QUANTITY");
      const row = await ctx.runQuery(component.charges.get, { key });
      const price = row?.profile && provider?.profiles?.[row.profile];

      if (!price) throw new Error("PROFILE_REQUIRED");

      return await ctx.runMutation(component.charges.update, {
        key,
        operation: "correct",
        operationKey,
        quantity,
        nanos: nanos(price.usd * quantity, LIMITS.maxBilledNanos),
        jobs: await jobs(meter),
      });
    },
    settle: async (cost) => {
      text(cost.key, "OPERATION_KEY", LIMITS.maxKeyBytes);
      await guard();

      return await ctx.runMutation(component.charges.update, {
        key,
        operation: "settle",
        operationKey: cost.key,
        ...costNanos(provider ?? {}, cost),
        jobs: await jobs(meter),
      });
    },
  };
}
