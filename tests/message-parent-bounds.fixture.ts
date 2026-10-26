/** Fill the bounded delivery range, including a settled-but-undelivered child. */
import { getConvexSize, v } from "convex/values";
import { mutation } from "../src/component/_generated/server.js";
import { HOST_LIMITS, LIMITS, readyRowLimit } from "../src/component/limits.js";
import { newRun } from "../src/component/turns/runs.js";
import { resolveRunSettings } from "../src/component/run-settings.js";
import { fillAssignment, fillNotes, fullReport } from "./assignment-envelope.fixture.js";

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
      .withIndex("by_group", (q) => q.eq("parentRunId", root.runId!))
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

/** Conservative cancellation envelope, seeded ONE assignment per transaction.
 * <=152 ready rows +152 full settings snapshots +one <=34 KiB assignment
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

    const budget = newRun(
      undefined,
      Array.from({ length: 64 }, (_, index) => ({
        agent: String(index).padEnd(100, "x"),
        settings: resolveRunSettings(),
      })),
    );

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
        ...(result
          ? {
              join: { newestSequence: index, earliestId: "e".repeat(200), earliestSequence: index },
            }
          : {}),
      };

      expectReadySize(ready);
      const id = await ctx.db.insert("inbox", ready);

      head ??= id;
    }

    const staged = await ctx.db.insert("inbox", {
      assignmentId,
      runId: childBudget ?? row.runId!,
      messageId: "",
      text: "\uFFFF".repeat(LIMITS.messageLength),
      sequence: row.nextSequence + count,
      kind: "continue",
      passive: false,
    });

    await ctx.db.patch("assignments", row._id, {
      turnReport: fullReport(head!),
      queuedMessages: count - 1,
      hookContinue: true,
      inboxId: staged,
      turnStatus: "queued",
      nextSequence: row.nextSequence + count,
      routingAgentIndex: 0,
      ...(childBudget ? { runId: childBudget } : {}),
    });

    await ctx.db.patch("runs", childBudget ?? row.runId!, { routingAgents: 1n });
    await fillNotes(ctx, { ...row, runId: childBudget ?? row.runId });
    await fillAssignment(ctx, row._id);

    return null;
  },
});

function expectReadySize(row: Parameters<typeof getConvexSize>[0]) {
  // Native ids/time add less than 128 bytes; cancel's envelope is 1 KiB/row.
  if (getConvexSize(row) > (1 << 10) - 128) throw new Error("FIXTURE_READY_ROW_TOO_LARGE");
}
