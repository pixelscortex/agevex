/**
 * Host-driven retention and explicit sink retry operations.
 * Retention is an admin operation whose caller supplies its authorization.
 * Sink retry checks subject ownership before resetting the bounded outbox;
 * neither operation starts paid provider work.
 */
import { authorize, jobs } from "./configuration.js";
import { lookupMs } from "./pricing.js";
/** Used by trusted close hooks and the authorized host backstop alike. */
export async function reconcile(meter, ctx, args) {
    return await ctx.runMutation(meter.component.charges.reconcile, {
        subject: args.subject,
        runId: args.runId,
        providers: Object.entries(meter.options.providers)
            .filter(([, provider]) => provider.lookup)
            .map(([name, provider]) => ({ name, lookupMs: lookupMs(provider) })),
        jobs: await jobs(meter),
    });
}
/** Compose maintenance calls without changing their existing authorization boundary. */
export function maintenance(meter) {
    const { component, limits } = meter;
    return {
        /** Explicit bounded backstop, safe to repeat after completion; no model calls. */
        reconcile: async (ctx, args) => {
            await authorize(meter, ctx, { subject: args.subject, runId: args.runId });
            return await reconcile(meter, ctx, args);
        },
        /**
         * Retention for host crons. A host admin operation like extract's
         * `purge`: it performs no `authorize`; expose it only behind an admin check.
         * Deletes up to `limit` (default 100, max 500) settled charges whose sinks
         * all acknowledged, created before `before`, and their aggregate entries.
         * It also stops at its transaction budget; call again while `more`. Choose
         * `before` past any replay window: a pruned key recorded again is new.
         */
        prune: async (ctx, args) => await ctx.runMutation(component.charges.prune, {
            ...args,
            minAgeMs: limits.pruneMinAgeMs,
        }),
        retrySinks: async (ctx, args) => {
            await authorize(meter, ctx, { subject: args.subject });
            const row = await ctx.runQuery(component.charges.get, { key: args.key });
            if (row?.attribution.subject !== args.subject)
                throw new Error("CHARGE_NOT_FOUND");
            return await ctx.runMutation(component.charges.retrySinks, {
                key: args.key,
                jobs: await jobs(meter),
            });
        },
    };
}
