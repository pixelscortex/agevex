import { resolveMeter } from "./configuration.js";
import { costReads } from "./reads.js";
import { maintenance } from "./maintenance.js";
import { scope } from "./scope.js";
import { usageSlot, budgetSlot } from "./slots.js";
import { internalFunctions } from "./workers.js";
export { inline } from "./pricing.js";
/** Validate registration once and bind the standalone API and core adapters to its context. */
export function defineMeter(component, options) {
    const meter = resolveMeter(component, options);
    return {
        scope: (ctx, attribution) => scope(meter, ctx, attribution),
        usageSlot: (slot = {}) => usageSlot(meter, slot),
        budgetSlot: (policy = options.budgets) => budgetSlot(meter, policy),
        ...costReads(meter),
        ...maintenance(meter),
        internalFunctions: () => internalFunctions(meter),
    };
}
