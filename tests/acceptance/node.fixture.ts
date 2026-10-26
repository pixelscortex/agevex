/** Test-only exact thread lookup; production exposes no assignment capabilities. */
import { v } from "convex/values";
import { query } from "../../src/component/_generated/server.js";

export const assignment = query({
  args: { threadId: v.string() },
  handler: (ctx, args) =>
    ctx.db
      .query("assignments")
      .withIndex("by_thread", (q) => q.eq("threadId", args.threadId))
      .unique(),
});
