/**
 * Authorized host reads and the run-scoped budget decision.
 * All totals come from the component aggregates, never from charge scans.
 * Optional grouping is checked against registration before invoking a query;
 * unknown charges deny work even when no spending cap has been configured,
 * except background (title/summary) charges, which never block their run.
 */
import { requireBreakdown } from "../shared/breakdowns.js";
import { LIMITS, integer, text } from "../shared/limits.js";
import { authorize, type MeterContext } from "./configuration.js";
import type { ReadCtx } from "./types.js";
import type { UsageViewArgs } from "../../../client/slots.js";

/** Check a budget snapshot after authorization; trusted core calls validate labels only. */
export async function check(
  meter: MeterContext,
  ctx: ReadCtx,
  args: { subject: string; runId?: string },
  budgetPolicy = meter.options.budgets,
  trusted = false,
) {
  if (trusted) {
    for (const value of Object.values(args)) if (value !== undefined) text(value, "ATTRIBUTION");
  } else await authorize(meter, ctx, args);

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
    // Run scope ignores unknown title/summary charges (see aggregates.ts); their
    // known amounts are already in totalNanos and every unknown stays in `unknown`.
    allowed: cost.blockingUnknown === 0 && (maxNanos === undefined || cost.totalNanos < maxNanos),
    ...cost,
    maxNanos: maxNanos ?? null,
  };
}

/** Compose the host read API with the same authorization and opt-in projection checks. */
export function costReads(meter: MeterContext) {
  const { component, breakdowns, limits } = meter;

  return {
    usageView: async (ctx: ReadCtx, args: UsageViewArgs) => {
      await authorize(meter, ctx, { subject: args.subject, runId: args.runId });

      return await ctx.runQuery(component.reads.usage, args);
    },
    threadCost: async (
      ctx: ReadCtx,
      args: { threadId: string; cursors?: Partial<Record<"agent" | "model" | "provider", string>> },
    ) => {
      await authorize(meter, ctx, { threadId: args.threadId });

      for (const axis of ["model", "provider"] as const)
        if (args.cursors?.[axis] !== undefined) requireBreakdown(breakdowns, `thread.${axis}`);

      return await ctx.runQuery(component.reads.threadCost, {
        ...args,
        breakdowns,
        maxGroups: limits.maxGroups,
      });
    },
    subjectCost: async (ctx: ReadCtx, args: { subject: string; runId?: string }) => {
      await authorize(meter, ctx, args);

      return await ctx.runQuery(component.reads.cost, args);
    },
    breakdown: async (
      ctx: ReadCtx,
      args: {
        subject: string;
        from: number;
        to: number;
        by: "day" | "agent" | "model" | "provider";
        cursor?: string;
      },
    ) => {
      await authorize(meter, ctx, { subject: args.subject });

      if (args.by !== "day") requireBreakdown(breakdowns, `subject.${args.by}`);

      return await ctx.runQuery(component.reads.breakdown, {
        ...args,
        breakdowns,
        maxGroups: limits.maxGroups,
        maxDays: limits.maxDays,
      });
    },
    check: (ctx: ReadCtx, args: { subject: string; runId?: string }) => check(meter, ctx, args),
  };
}
