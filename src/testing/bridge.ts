// Test-only forwarding preserves Convex's real nested component boundary.
// A childComponent reference addresses one component level, not a slash path.
import {
  componentsGeneric,
  internalMutationGeneric,
  internalQueryGeneric,
  type FunctionReference,
} from "convex/server";
import { v } from "convex/values";
import { HOST_LIMITS, LIMITS } from "../component/limits.js";
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

/** Inspect the bounded regression fixture after cancellation commits. */
export const queuedWork = internalQueryGeneric({
  args: {},
  handler: async (ctx) => ({
    inbox: await ctx.db.query("inbox").collect(),
    runs: await ctx.db.query("runs").collect(),
  }),
});

/** Bounded inspection for the ledger purge margin regression. */
export const receiptCount = internalQueryGeneric({
  args: {},
  handler: async (ctx) => (await ctx.db.query("receipts").take(LIMITS.purgeBatch + 1)).length,
});

/** Inspect the exact child result recorded on one run, without native history. */
export const childResultMessageId = internalQueryGeneric({
  args: { runId: v.string() },
  handler: async (ctx, { runId }) =>
    (
      await ctx.db
        .query("subagentRuns")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .unique()
    )?.childResultMessageId ?? null,
});

/** Populate the F1 coordination envelope for the all-maxima cancellation
 * fixture. Bodies remain in Agent; cancellation must only touch this metadata. */
export const fillHookMetadata = internalMutationGeneric({
  args: { assignmentId: v.id("assignments") },
  returns: v.null(),
  handler: async (ctx, { assignmentId }) => {
    await ctx.db.patch("assignments", assignmentId, {
      contextSequence: LIMITS.contextMessages,
      contextMessages: Array.from({ length: LIMITS.contextMessages }, (_, order) => ({
        id: crypto.randomUUID(),
        order,
        stepOrder: 0,
        bytes: 1 << 20,
        sequence: order,
      })),
      reviewed: Array.from({ length: LIMITS.sideAgents }, (_, turn) => ({
        agent: "\uFFFF".repeat(LIMITS.requestKeyLength - 1) + turn,
        turn,
        at: Date.now(),
        boundary: turn,
      })),
      hookError: "\uFFFF".repeat(LIMITS.hookErrorLength),
      completedTurns: LIMITS.turnsPerLoop,
      notesTaken: HOST_LIMITS.notesPerTurn.max,
      logicalPromptMessageId: crypto.randomUUID(),
    });
    return null;
  },
});
