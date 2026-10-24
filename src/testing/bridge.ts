// Test-only forwarding preserves Convex's real nested component boundary.
// A childComponent reference addresses one component level, not a slash path.
import {
  componentsGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  type FunctionReference,
} from "convex/server";
import { v } from "convex/values";
const args = { lane: v.string(), module: v.string(), name: v.string(), args: v.any() };
export const read = internalQueryGeneric({
  args,
  handler: (ctx, a) =>
    ctx.runQuery(
      componentsGeneric()[a.lane][a.module][a.name] as unknown as FunctionReference<"query">,
      a.args,
    ),
});
export const write = internalMutationGeneric({
  args,
  handler: (ctx, a) =>
    ctx.runMutation(
      componentsGeneric()[a.lane][a.module][a.name] as unknown as FunctionReference<"mutation">,
      a.args,
    ),
});

/** Observe scheduler activity in this component, including completed checks. */
export const recoveryJobs = internalQueryGeneric({
  args: {},
  handler: async (ctx) => {
    const jobs = (await ctx.db.system.query("_scheduled_functions").collect()).filter(
      (job) => job.name === "queue:reconcile",
    );
    return {
      total: jobs.length,
      pending: jobs.filter((job) => job.state.kind === "pending" || job.state.kind === "inProgress")
        .length,
    };
  },
});
