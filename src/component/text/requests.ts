/** Explicit on-demand summary scheduling uses existing receipt idempotency.
 * No cadence, summary content or task state is retained on assignments. */
import { v } from "convex/values";
import { mutation } from "../_generated/server.js";
import { LIMITS } from "../limits.js";
import { queueText } from "./jobs.js";

export const response = v.object({ messageId: v.string(), replayed: v.boolean() });

/** Repeated request keys never buy another generation, including after unknown
 * provider outcomes. A fresh key explicitly requests a fresh summary. */
export const summarize = mutation({
  args: { assignmentId: v.id("assignments"), requestKey: v.string() },
  returns: v.object({ status: v.union(v.literal("queued"), v.literal("replayed")) }),
  handler: async (ctx, args) => {
    if (!args.requestKey || args.requestKey.length > LIMITS.requestKeyLength)
      throw new Error("INVALID_REQUEST_KEY");

    const row = await ctx.db.get("assignments", args.assignmentId);

    if (!row || row.childRunId || !row.textConfig?.summary) throw new Error("SUMMARY_DISABLED");

    if (row.cancelled) throw new Error("CANCELLED");

    const head = !row.runId && row.inboxId ? await ctx.db.get("inbox", row.inboxId) : null;
    const runId = row.runId ?? head?.runId;

    if (!runId) throw new Error("NO_RUN");

    const queued = await queueText(ctx, row, "summary", runId, undefined, args.requestKey);

    return { status: queued ? ("queued" as const) : ("replayed" as const) };
  },
});
