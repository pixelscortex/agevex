/**
 * Authorized host reads and the run-scoped budget decision.
 * All totals come from the component aggregates, never from charge scans.
 * Optional grouping is checked against registration before invoking a query;
 * unknown charges deny work even when no spending cap has been configured.
 */
import { requireBreakdown } from "../shared/breakdowns.js";
import { LIMITS, integer, text } from "../shared/limits.js";
import { authorize } from "./configuration.js";
/** Check a budget snapshot after authorization; trusted core calls validate labels only. */
export async function check(meter, ctx, args, budgetPolicy = meter.options.budgets, trusted = false) {
    if (trusted) {
        for (const value of Object.values(args))
            if (value !== undefined)
                text(value, "ATTRIBUTION");
    }
    else
        await authorize(meter, ctx, args);
    const policy = await budgetPolicy?.(args);
    // Budget caps can cover many charges, so the bound is the exact-integer
    // ceiling, not the per-charge cap. A total at or beyond 2^53 is still
    // >= any such cap, so imprecision there can only deny, never admit.
    if (policy && (!Number.isFinite(policy.maxUsd) || policy.maxUsd < 0))
        throw new Error("INVALID_BUDGET");
    const maxNanos = policy
        ? integer(Math.round(policy.maxUsd * LIMITS.nanosPerUsd), Number.MAX_SAFE_INTEGER, "BUDGET")
        : undefined;
    const cost = await ctx.runQuery(meter.component.reads.cost, args);
    return {
        allowed: cost.unknown === 0 && (maxNanos === undefined || cost.totalNanos < maxNanos),
        ...cost,
        maxNanos: maxNanos ?? null,
    };
}
/** Compose the host read API with the same authorization and opt-in projection checks. */
export function costReads(meter) {
    const { component, breakdowns, limits } = meter;
    return {
        usageView: async (ctx, args) => {
            await authorize(meter, ctx, { subject: args.subject, runId: args.runId });
            return await ctx.runQuery(component.reads.usage, args);
        },
        threadCost: async (ctx, args) => {
            await authorize(meter, ctx, { threadId: args.threadId });
            for (const axis of ["model", "provider"])
                if (args.cursors?.[axis] !== undefined)
                    requireBreakdown(breakdowns, `thread.${axis}`);
            return await ctx.runQuery(component.reads.threadCost, {
                ...args,
                breakdowns,
                maxGroups: limits.maxGroups,
            });
        },
        subjectCost: async (ctx, args) => {
            await authorize(meter, ctx, args);
            return await ctx.runQuery(component.reads.cost, args);
        },
        breakdown: async (ctx, args) => {
            await authorize(meter, ctx, { subject: args.subject });
            if (args.by !== "day")
                requireBreakdown(breakdowns, `subject.${args.by}`);
            return await ctx.runQuery(component.reads.breakdown, {
                ...args,
                breakdowns,
                maxGroups: limits.maxGroups,
                maxDays: limits.maxDays,
            });
        },
        check: (ctx, args) => check(meter, ctx, args),
    };
}
