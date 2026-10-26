/** Fill the bounded delivery range, including a settled-but-undelivered child. */
import { v } from "convex/values";
import { mutation } from "../src/component/_generated/server.js";
import { HOST_LIMITS } from "../src/component/limits.js";

/** The live actor and terminal gap both need final hops, even with activeRuns=1.
 * Keep all 58 rows near their 4 KiB metadata envelope; no native bodies copied.
 */
export const seed = mutation({
  args: { assignmentId: v.id("assignments") },
  returns: v.null(),
  handler: async (ctx, { assignmentId }) => {
    const root = (await ctx.db.get("assignments", assignmentId))!;

    const live = (await ctx.db
      .query("subagentRuns")
      .withIndex("by_group", (q) => q.eq("parentRunId", root.runId!))
      .first())!;

    const { _id, _creationTime, ...template } = live;
    const ordinary = HOST_LIMITS.runLaunches.max;
    const sides = HOST_LIMITS.sideRunsPerRun.max;

    for (let index = 1; index < ordinary + sides; index++)
      await ctx.db.insert("subagentRuns", {
        ...template,
        runId: `headroom-${index}`,
        dedupKey: `headroom-${index}`,
        payloadFingerprint: "x".repeat(3 << 10),
        side: index >= ordinary || undefined,
        childAssignmentId: undefined,
        childThreadId: undefined,
        sequence: index + 1,
        status: "completed",
        // Exactly one terminal ordinary result still awaits delivery; the
        // remaining history and side reviews reserve no final-result hops.
        deliveryStatus: index === 1 ? "pending" : index === 2 ? "failed" : "accepted",
      });

    await ctx.db.patch("runs", root.runId!, {
      launches: ordinary,
      sideRuns: sides,
      // 50 launches +47 accepted ordinary results; failed/side results spend no hop.
      hops: HOST_LIMITS.runHops.max - 3,
    });

    return null;
  },
});

/** Older requests may settle before their notifications run. Fill the queue's
 * reservation range across two budgets, keeping each within its launch cap.
 * <=99 rows *4 KiB plus three <=16 KiB budgets stays below 512 KiB written.
 */
export const fillQueue = mutation({
  args: { assignmentId: v.id("assignments") },
  returns: v.null(),
  handler: async (ctx, { assignmentId }) => {
    const root = (await ctx.db.get("assignments", assignmentId))!;

    const live = (await ctx.db
      .query("subagentRuns")
      .withIndex("by_group", (q) => q.eq("parentRunId", root.runId!))
      .first())!;

    const budget = (await ctx.db.get("runs", root.runId!))!;
    const { _id, _creationTime, ...template } = live;
    const { _id: _budgetId, _creationTime: _budgetCreated, ...budgetTemplate } = budget;
    const launchCap = HOST_LIMITS.runLaunches.max;
    const pending = HOST_LIMITS.queueLength.max - 1;

    for (let offset = 0; offset < pending; offset += launchCap) {
      const launches = Math.min(launchCap, pending - offset);

      const parentRunId = await ctx.db.insert("runs", {
        ...budgetTemplate,
        launches,
        hops: launches,
      });

      for (let child = 0; child < launches; child++)
        await ctx.db.insert("subagentRuns", {
          ...template,
          parentRunId,
          runId: `older-pending-${offset + child}`,
          dedupKey: `older-pending-${offset + child}`,
          payloadFingerprint: "x".repeat(3 << 10),
          childAssignmentId: undefined,
          childThreadId: undefined,
          status: "completed",
          sequence: offset + child + 2,
        });
    }

    return null;
  },
});
