/** Host internal mutation with durable external-id deduplication, without network IO. */
import { internalMutationGeneric } from "convex/server";
import { v } from "convex/values";
import { event } from "../../../src/modules/meter/component/schema.js";

/** One indexed receipt read and at most one small host write per event. */
export const receive = internalMutationGeneric({
  args: { event },
  returns: v.null(),
  handler: async (ctx, args) => {
    const previous = await ctx.db
      .query("sinkReceipts")
      .withIndex("by_external_id", (q) => q.eq("externalId", args.event.externalId))
      .unique();

    if (!previous) await ctx.db.insert("sinkReceipts", args.event);

    return null;
  },
});
