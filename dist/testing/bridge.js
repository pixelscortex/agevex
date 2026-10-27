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
import { assertSettingsSnapshot, settingsSnapshot, RUN_LIMITS } from "../component/run_settings.js";
import { LIMITS } from "../component/limits.js";
import { internalQuery } from "../component/_generated/server.js";
import { assignmentByThread } from "../component/turns/assignments.js";
import { runTimes } from "../component/subagents/runs.js";
/** Existing delegation protocol tests inspect stored states (asking/completed),
 * distinct from the new public asleep/done projection. Never shipped in core.
 */
export const delegationState = internalQuery({
    args: { threadId: v.string() },
    handler: async (ctx, { threadId }) => {
        const root = await assignmentByThread(ctx, threadId);
        if (!root?.runId)
            return [];
        const rows = await ctx.db
            .query("subagentRuns")
            .withIndex("by_parent_run", (q) => q.eq("parentRunId", root.runId))
            .take(root.limits.runLaunches);
        return rows
            .sort((a, b) => a.sequence - b.sequence)
            .map((run) => ({
            runId: run.runId,
            parentAssignmentId: run.actorAssignmentId,
            childAssignmentId: run.childAssignmentId ?? null,
            agent: run.agent,
            status: run.status,
            depth: run.depth,
            childThreadId: run.childThreadId ?? null,
            createdAt: run._creationTime,
            startedAt: run.startedAt ?? null,
            finishedAt: runTimes(run).finishedAt,
        }));
    },
});
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
        const row = await ctx.db.get("assignments", assignmentId);
        await ctx.db.patch("assignments", assignmentId, {
            turnReport: {
                promptMessageId: "p".repeat(LIMITS.messageIdBytes),
                messageIds: Array.from({ length: RUN_LIMITS.stepsPerTurn.max - 1 }, (_, i) => String(i).padStart(LIMITS.messageIdBytes, "m")),
                maxMessages: RUN_LIMITS.stepsPerTurn.max,
                resumeInboxId: row?.inboxId,
            },
        });
        return null;
    },
});
/** Exact run and claim-armed watchdog metadata for offline settings fixtures. */
export const runMetadata = internalQueryGeneric({
    args: { assignmentId: v.string() },
    handler: async (ctx, { assignmentId }) => {
        const id = ctx.db.normalizeId("assignments", assignmentId);
        const row = id ? await ctx.db.get(id) : null;
        return {
            run: row?.runId ? await ctx.db.get(row.runId) : null,
            watchdog: row?.watchdogId ? await ctx.db.system.get(row.watchdogId) : null,
        };
    },
});
/** Fill the <=168-run cancellation fixture with maximum-size accepted settings.
 * Read+patch <=168*16 KiB twice (<6 MiB), no messages or transcript scans. */
export const fillRunSettings = internalMutationGeneric({
    args: { settings: v.optional(settingsSnapshot) },
    handler: async (ctx, { settings }) => {
        if (settings)
            assertSettingsSnapshot(settings);
        const rows = await ctx.db.query("runs").take(RUN_LIMITS.cancelBudgets);
        for (const row of rows)
            await ctx.db.patch(row._id, { settings, usagePartial: undefined });
        return null;
    },
});
