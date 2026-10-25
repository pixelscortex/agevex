/**
 * Message origins for the public thread reader (`origins`).
 *
 * The reader shows a page of native messages; for each id it asks whether the
 * message was an agevex control (a note, with its sender, or a hook
 * continuation) or a delivered child result (with its run id). Both answers
 * come from exact-id indexes (`inbox.by_message`,
 * `subagentRuns.by_result_message`) scoped to the page, never history.
 */
import { type QueryCtx, query } from "../_generated/server.js";
import type { Id } from "../_generated/dataModel.js";
import { LIMITS } from "../limits.js";
import { v } from "convex/values";

type Origin = { origin: "note" | "continue" | "result"; from?: string; runId?: string };

/** Page-local indexed lookups: <=100 controls *1 KiB +100 results *4 KiB
 * +32 KiB ownership =532 KiB, <=201 documents and <=201 index queries.
 * Control rows with a native id never retain bodies; no history prefix is read.
 * Only rows belonging to this subject's assignment are reported.
 */
export async function messageOrigins(
  ctx: QueryCtx,
  args: { assignmentId: Id<"assignments">; subject: string; messageIds: string[] },
) {
  if (args.messageIds.length > LIMITS.messagePage) throw new Error("INVALID_PAGE");

  const row = await ctx.db.get("assignments", args.assignmentId);

  if (!row || row.subject !== args.subject) throw new Error("FORBIDDEN");

  const origins: Record<string, Origin> = {};

  for (const id of args.messageIds) {
    const control = await ctx.db
      .query("inbox")
      .withIndex("by_message", (q) => q.eq("messageId", id))
      .unique();

    if (
      control?.assignmentId === row._id &&
      (control.kind === "note" || control.kind === "continue")
    ) {
      origins[id] = {
        origin: control.kind,
        ...(control.kind === "note" ? { from: control.from! } : {}),
      };

      continue;
    }

    const result = await ctx.db
      .query("subagentRuns")
      .withIndex("by_result_message", (q) => q.eq("resultMessageId", id))
      .unique();

    if (result?.actorAssignmentId === row._id)
      origins[id] = { origin: "result", runId: result.runId };
  }

  return origins;
}

/** Label note, continuation and result messages on one reader page. */
export const origins = query({
  args: { assignmentId: v.id("assignments"), subject: v.string(), messageIds: v.array(v.string()) },
  handler: (ctx, args) => messageOrigins(ctx, args),
});
