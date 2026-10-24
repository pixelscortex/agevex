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
