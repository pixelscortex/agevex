// Test-only bridge mounted into the component as `agevexTest` by `agevex/test`
// (`src/test.ts`); never part of the production component.
//
// `read` / `write` forward a call one component level down (Workflow, Workpool),
// preserving Convex's real nested component boundary: a childComponent reference
// addresses one component level, not a slash path. The remaining queries and
// mutations are bounded white-box inspections and fixtures that tests use to
// observe component tables (assignments, inbox, runs, receipts) directly.
import { componentsGeneric, internalMutationGeneric, internalQueryGeneric, } from "convex/server";
import { v } from "convex/values";
import { LIMITS } from "../component/limits.js";
const args = { lane: v.string(), module: v.string(), name: v.string(), args: v.any() };
/** Forward one query to `components[lane][module][name]` of this component. */
export const read = internalQueryGeneric({
    args,
    handler: (ctx, a) => ctx.runQuery(componentsGeneric()[a.lane][a.module][a.name], a.args),
});
/** Forward one mutation to `components[lane][module][name]` of this component. */
export const write = internalMutationGeneric({
    args,
    handler: (ctx, a) => ctx.runMutation(componentsGeneric()[a.lane][a.module][a.name], a.args),
});
/** Observe scheduler activity in this component, including completed checks. */
export const recoveryJobs = internalQueryGeneric({
    args: {},
    handler: async (ctx) => {
        const jobs = (await ctx.db.system.query("_scheduled_functions").collect()).filter((job) => job.name === "turns/loop:reconcile");
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
        inbox: (await ctx.db.query("inbox").collect()).filter((row) => row.passive !== false),
        runs: await ctx.db.query("runs").collect(),
    }),
});
/** Bounded inspection for the ledger purge margin regression. */
export const receiptCount = internalQueryGeneric({
    args: {},
    handler: async (ctx) => (await ctx.db.query("receipts").take(LIMITS.purgeBatch + 1)).length,
});
/** White-box tests read the whole coordination row; turns.slices.execution returns
 * only the projection the runtime reads. */
export const assignment = internalQueryGeneric({
    args: { assignmentId: v.string() },
    handler: async (ctx, { assignmentId }) => {
        const id = ctx.db.normalizeId("assignments", assignmentId);
        return id ? await ctx.db.get(id) : null;
    },
});
/** Inspect the exact child result recorded on one run, without native history. */
export const childResultMessageId = internalQueryGeneric({
    args: { runId: v.string() },
    handler: async (ctx, { runId }) => (await ctx.db
        .query("subagentRuns")
        .withIndex("by_run", (q) => q.eq("runId", runId))
        .unique())?.childResultMessageId ?? null,
});
/** Populate the F1 coordination envelope for the all-maxima cancellation
 * fixture. Bodies remain in Agent; cancellation must only touch this metadata. */
export const fillHookMetadata = internalMutationGeneric({
    args: { assignmentId: v.id("assignments") },
    returns: v.null(),
    handler: async (ctx, { assignmentId }) => {
        await ctx.db.patch("assignments", assignmentId, {
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
            completedTurns: LIMITS.turnsPerLoop,
        });
        return null;
    },
});
