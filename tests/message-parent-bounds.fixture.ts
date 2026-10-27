/** Fill the bounded delivery range, including a settled-but-undelivered child. */
import { v } from "convex/values";
import { valueBytes } from "../src/shared/json.js";
import { mutation } from "../src/component/_generated/server.js";
import { HOST_LIMITS, readyRowLimit } from "../src/component/limits.js";
import {
  fillAssignment,
  fillNotes,
  fullReport,
  maximumRun,
} from "./assignment-envelope.fixture.js";

/** The live actor and terminal gap both need final hops, even with activeRuns=1.
 * Keep all 50 rows near their 4 KiB metadata envelope; no native bodies copied.
 */
export const seed = mutation({
  args: { assignmentId: v.id("assignments") },
  returns: v.null(),
  handler: async (ctx, { assignmentId }) => {
    const root = (await ctx.db.get("assignments", assignmentId))!;

    const live = (await ctx.db
      .query("subagentRuns")
      .withIndex("by_parent_run", (q) => q.eq("parentRunId", root.runId!))
      .first())!;

    const { _id, _creationTime, ...template } = live;
    const ordinary = HOST_LIMITS.runLaunches.max;

    for (let index = 1; index < ordinary; index++)
      await ctx.db.insert("subagentRuns", {
        ...template,
        dedupKey: `headroom-${index}`,
        payloadFingerprint: "x".repeat(3 << 10),
        childAssignmentId: undefined,
        childThreadId: undefined,
        sequence: index + 1,
        status: "completed",
        // Exactly one terminal ordinary result still awaits delivery; the
        // remaining history reserves no final-result hops.
        deliveryStatus: index === 1 ? "pending" : index === 2 ? "failed" : "accepted",
      });

    await ctx.db.patch("runs", root.runId!, {
      launches: ordinary,
      // 50 launches +47 accepted ordinary results; failed results spend no hop.
      hops: HOST_LIMITS.runHops.max - 3,
    });

    return null;
  },
});

/** Older requests may settle before their notifications run. Fill the maximum
 * outstanding result work across budgets without occupying message slots.
 * <=49 rows *4 KiB plus two <=16 KiB budgets stays below 256 KiB written.
 */
export const fillQueue = mutation({
  args: { assignmentId: v.id("assignments") },
  returns: v.null(),
  handler: async (ctx, { assignmentId }) => {
    const root = (await ctx.db.get("assignments", assignmentId))!;

    const live = (await ctx.db
      .query("subagentRuns")
      .withIndex("by_parent_run", (q) => q.eq("parentRunId", root.runId!))
      .first())!;

    const budget = (await ctx.db.get("runs", root.runId!))!;
    const { _id, _creationTime, ...template } = live;
    const { _id: _budgetId, _creationTime: _budgetCreated, ...budgetTemplate } = budget;
    const launchCap = HOST_LIMITS.runLaunches.max;
    const pending = HOST_LIMITS.runLaunches.max - 1;

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

/** Conservative cancellation envelope, seeded ONE assignment per transaction.
 * <=152 ready rows +152 full settings snapshots +one <=16 KiB assignment
 * stay <3 MiB written per seed. Root rows use distinct request budgets;
 * child rows share one inherited budget. Across 16 assignments cancel must
 * clear all 2,432 ready rows and 168 distinct budgets in one transaction.
 * This overfills simultaneous per-run hop/launch usage intentionally: proving
 * the full envelope is stronger than relying on incompatible maxima to fit.
 */
export const fillCancelQueue = mutation({
  args: { assignmentId: v.id("assignments") },
  returns: v.null(),
  handler: async (ctx, { assignmentId }) => {
    const row = (await ctx.db.get("assignments", assignmentId))!;

    const budget = maximumRun();

    if (!row.childRunId) await ctx.db.patch("runs", row.runId!, { settings: budget.settings });

    const childBudget = row.childRunId ? await ctx.db.insert("runs", budget) : undefined;
    const count = readyRowLimit(row.limits);
    let head;

    for (let index = 0; index < count; index++) {
      const runId = childBudget ?? (await ctx.db.insert("runs", budget));
      const result = index >= row.limits.queueLength && index < count - 2;

      const ready = {
        assignmentId,
        runId,
        sequence: row.nextSequence + index,
        messageId: "m".repeat(200),
        from: "f".repeat(200),
        kind: result ? ("result" as const) : ("parent" as const),
      };

      expectReadySize(ready);
      const id = await ctx.db.insert("inbox", ready);

      head ??= id;
    }

    await ctx.db.patch("assignments", row._id, {
      turnReport: fullReport(head!),
      queuedMessages: count - 1,
      inboxId: head,
      turnStatus: "queued",
      nextSequence: row.nextSequence + count,
      ...(childBudget ? { runId: childBudget } : {}),
    });

    await fillNotes(ctx, { ...row, runId: childBudget ?? row.runId });
    await fillAssignment(ctx, row._id);

    return null;
  },
});

function expectReadySize(row: unknown) {
  // Native ids/time add less than 128 bytes; cancel's envelope is 1 KiB/row.
  if (valueBytes(row) > (1 << 10) - 128) throw new Error("FIXTURE_READY_ROW_TOO_LARGE");
}
