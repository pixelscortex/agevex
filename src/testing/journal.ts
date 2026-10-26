// Test-only module mounted inside Workflow's real schema by agevex/test. It is
// never exported from the production component.
//
// `turns` reads every recorded workflow with its journal steps; `clone` copies one
// workflow's journal and replays it through Workflow's real engine (replaying a
// clone avoids firing an old nested-workflow completion callback into the live
// loop a second time); `result` reads the replay outcome. `expect-journal.ts`
// drives these to prove the step order is unchanged. Below them, `dropPings`
// injects a fault by deleting unconsumed `ping` events, and `events` counts
// orphaned events, both directly on Workflow's own tables.

import { internalMutationGeneric, internalQueryGeneric, type FunctionHandle } from "convex/server";
import { v } from "convex/values";

export const REPLAY_BOUNDARY = "AGEVEX_JOURNAL_REPLAY_BOUNDARY";

type Workflow = {
  _id: string;
  _creationTime: number;
  workflowHandle: string;
  args: { assignmentId: string; executionId?: string; version: number };
};
type Entry = {
  _id: string;
  _creationTime: number;
  workflowId: string;
  stepNumber: number;
  step: Record<string, unknown>;
};

/** Every workflow (oldest first) with its journal steps in step order. */
export const turns = internalQueryGeneric({
  args: {},
  handler: async (ctx) => {
    const workflows = (await ctx.db.query("workflows").collect()) as Workflow[];
    const entries = (await ctx.db.query("steps").collect()) as Entry[];

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

    if (!source) throw new Error("WORKFLOW_NOT_FOUND");

    const id = await ctx.db.insert("workflows", {
      workflowHandle: source.workflowHandle,
      args: source.args,
      generationNumber: 0,
    });

    const entries = (await ctx.db.query("steps").collect()) as Entry[];

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
          : entry.step,
      });

    await ctx.runMutation(source.workflowHandle as FunctionHandle<"mutation">, {
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

/** Fault injection drops only unconsumed doorbells, never accepted inbox rows. */
export const dropPings = internalMutationGeneric({
  args: { workflowId: v.id("workflows") },
  returns: v.null(),
  handler: async (ctx, { workflowId }) => {
    for (const row of await ctx.db.query("events").collect())
      if (row.workflowId === workflowId && row.name === "ping" && row.state.kind === "sent")
        await ctx.db.delete(row._id);

    return null;
  },
});

/** Count orphaned events using the real nested Workflow store. */
export const events = internalQueryGeneric({
  args: {},
  handler: async (ctx) => {
    const events = await ctx.db.query("events").collect();
    let orphaned = 0;

    for (const event of events) if (!(await ctx.db.get(event.workflowId))) orphaned++;

    return { orphaned, total: events.length };
  },
});
