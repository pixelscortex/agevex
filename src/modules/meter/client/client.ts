/**
 * Public host meter factory: resolve registration and compose focused builders.
 * The installing app uses this API for scoped recording, aggregate reads,
 * core slots, maintenance and internal worker exports. Component function
 * paths and per-operation authorization remain owned by their respective builders.
 */
import type { ComponentApi } from "../component/_generated/component.js";
import { resolveMeter } from "./configuration.js";
import { costReads } from "./reads.js";
import { maintenance } from "./maintenance.js";
import { scope } from "./scope.js";
import { usageSlot, budgetSlot } from "./slots.js";
import { internalFunctions } from "./workers.js";
import type { Attribution, MeterOptions, WriteCtx } from "./types.js";

export { inline } from "./pricing.js";

/** Validate registration once and bind the standalone API and core adapters to its context. */
export function defineMeter(component: ComponentApi, options: MeterOptions) {
  const meter = resolveMeter(component, options);

  return {
    scope: (ctx: WriteCtx, attribution: Attribution) => scope(meter, ctx, attribution),
    usageSlot: (slot: { providers?: Record<string, string> } = {}) => usageSlot(meter, slot),
    budgetSlot: (policy: MeterOptions["budgets"] = options.budgets) => budgetSlot(meter, policy),
    ...costReads(meter),
    ...maintenance(meter),
    internalFunctions: () => internalFunctions(meter),
  };
}

export type Meter = ReturnType<typeof defineMeter>;
/** Agent pages are always present; model/provider pages are optional opt-ins. */
export type ThreadCost = Awaited<ReturnType<Meter["threadCost"]>>;
