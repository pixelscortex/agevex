// Test-only module mounted inside Workflow's real schema by agevex/test. It is
// never exported from the production component.
//
// `turns` reads every recorded workflow with its journal steps; `clone` copies one
// workflow's journal and replays it through Workflow's real engine (replaying a
// clone avoids firing an old nested-workflow completion callback into the live
// loop a second time); `result` reads the replay outcome. `expect-journal.ts`
// drives these to prove step order. `events` counts orphaned Workflow events.
import { componentsGeneric, internalMutationGeneric, internalQueryGeneric, } from "convex/server";
import { v } from "convex/values";
import { LIMITS } from "../component/limits.js";
export const REPLAY_BOUNDARY = "AGEVEX_JOURNAL_REPLAY_BOUNDARY";
/** Every workflow (oldest first) with its journal steps in step order. */
export const turns = internalQueryGeneric({
    args: {},
    handler: async (ctx) => {
        const workflows = (await ctx.db.query("workflows").collect());
        const entries = (await ctx.db.query("steps").collect());
        return workflows
            .sort((a, b) => a._creationTime - b._creationTime)
            .map((row) => ({
            id: row._id,
            args: row.args,
            kind: row.args.executionId ? "turn" : "loop",
            steps: entries
                .filter((entry) => entry.workflowId === row._id)
                .sort((a, b) => a.stepNumber - b.stepNumber)
                .map((entry) => entry.step),
        }));
    },
});
/**
 * Clone one workflow's journal into a fresh workflow and start its replay.
 * The in-progress step becomes a recorded sentinel failure (`REPLAY_BOUNDARY`).
 */
export const clone = internalMutationGeneric({
    args: { workflowId: v.id("workflows") },
    returns: v.string(),
    handler: async (ctx, { workflowId }) => {
        const source = await ctx.db.get(workflowId);
        if (!source)
            throw new Error("WORKFLOW_NOT_FOUND");
        const id = await ctx.db.insert("workflows", {
            workflowHandle: source.workflowHandle,
            args: source.args,
            generationNumber: 0,
        });
        const entries = (await ctx.db.query("steps").collect());
        for (const entry of entries.filter((entry) => entry.workflowId === workflowId))
            await ctx.db.insert("steps", {
                workflowId: id,
                stepNumber: entry.stepNumber,
                // A pending event would make Workflow short-circuit before replaying
                // any history. Turn it into a recorded sentinel failure: the handler
                // must consume every historical step and reach this exact boundary,
                // without issuing a new query/action or consuming the live event.
                step: entry.step.inProgress
                    ? {
                        ...entry.step,
                        inProgress: false,
                        completedAt: 0,
                        runResult: { kind: "failed", error: REPLAY_BOUNDARY },
                    }
                    : { ...entry.step, args: replaceWorkflow(entry.step.args, workflowId, id) },
            });
        await ctx.runMutation(source.workflowHandle, {
            workflowId: id,
            generationNumber: 0,
        });
        return id;
    },
});
/** The run result of a (cloned) workflow, or null while it has none. */
export const result = internalQueryGeneric({
    args: { workflowId: v.id("workflows") },
    handler: async (ctx, { workflowId }) => (await ctx.db.get(workflowId))?.runResult ?? null,
});
/** Count orphaned events using the real nested Workflow store. */
export const events = internalQueryGeneric({
    args: {},
    handler: async (ctx) => {
        const events = await ctx.db.query("events").collect();
        let orphaned = 0;
        for (const event of events)
            if (!(await ctx.db.get(event.workflowId)))
                orphaned++;
        return { orphaned, total: events.length };
    },
});
/** Clone ownership ids as well as the journal; live workflow ids are fenced. */
function replaceWorkflow(value, source, target) {
    if (value === source)
        return target;
    if (Array.isArray(value))
        return value.map((item) => replaceWorkflow(item, source, target));
    if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, replaceWorkflow(item, source, target)]));
    return value;
}
/** Reach the test-only scheduler fault in this lane's nested Workpool. */
export const interrupt = internalMutationGeneric({
    args: { mode: v.union(v.literal("scheduler"), v.literal("failed"), v.literal("canceled")) },
    returns: v.number(),
    handler: (ctx, args) => ctx.runMutation(componentsGeneric().workpool.agevexCrash
        .interrupt, args),
});
/** Callback failure must remain observable, never trigger a hidden repair job. */
export const completionFailures = internalQueryGeneric({
    args: {},
    returns: v.array(v.any()),
    handler: (ctx) => ctx.db.query("onCompleteFailures").take(10),
});
/** Fill the bounded loop journal before measuring the entire completion call.
 * Historical turns are already complete; only the original last pair is live.
 * Distinct nested ids exercise Workflow's real batch cleanup bookkeeping.
 */
export const fillCompletionHistory = internalMutationGeneric({
    args: { workflowId: v.id("workflows") },
    returns: v.number(),
    handler: async (ctx, { workflowId }) => {
        const entries = await ctx.db
            .query("steps")
            .withIndex("workflow", (q) => q.eq("workflowId", workflowId))
            .take(2);
        const next = entries[0];
        const turn = entries[1];
        if (entries.length !== 2 || turn.step.kind !== "workflow")
            throw new Error("FIXTURE_EXPECTED_FIRST_TURN");
        const nested = await ctx.db.get(turn.step.workflowId);
        if (!nested)
            throw new Error("FIXTURE_EXPECTED_NESTED_WORKFLOW");
        for (let i = 0; i < LIMITS.turnsPerLoop - 1; i++) {
            const nestedId = await ctx.db.insert("workflows", {
                workflowHandle: nested.workflowHandle,
                args: nested.args,
                generationNumber: 0,
                runResult: { kind: "success", returnValue: null },
            });
            await ctx.db.insert("steps", {
                workflowId,
                stepNumber: i * 2,
                step: { ...next.step, inProgress: false, completedAt: Date.now() },
            });
            await ctx.db.insert("steps", {
                workflowId,
                stepNumber: i * 2 + 1,
                step: {
                    ...turn.step,
                    workflowId: nestedId,
                    inProgress: false,
                    completedAt: Date.now(),
                    runResult: { kind: "success", returnValue: null },
                },
            });
        }
        await ctx.db.patch(next._id, { stepNumber: (LIMITS.turnsPerLoop - 1) * 2 });
        await ctx.db.patch(turn._id, { stepNumber: LIMITS.turnsPerLoop * 2 - 1 });
        return LIMITS.turnsPerLoop * 2;
    },
});
