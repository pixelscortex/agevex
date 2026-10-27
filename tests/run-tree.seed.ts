/** Component-local adversarial fixtures; these handlers never ship in core. */
import { v } from "convex/values";
import type { Doc } from "../src/component/_generated/dataModel.js";
import { mutation, query, type MutationCtx } from "../src/component/_generated/server.js";
import { newRootAssignment } from "../src/component/turns/assignments.js";
import { newRun } from "../src/component/turns/runs.js";
import { newSubagentRun } from "../src/component/subagents/runs.js";
import { HOST_LIMITS, LIMITS, resolveLimits } from "../src/component/limits.js";
import { TREE_LIMITS } from "../src/component/run_tree_values.js";
import { resolveRunSettings } from "../src/component/run_settings.js";
import { valueBytes } from "../src/shared/json.js";
import { maximumLimits, maximumRun, padded } from "./assignment-envelope.fixture.js";
import { closeRootRun, endRootTurn } from "../src/component/turns/run_lifecycle.js";

export const seedMaximum = mutation({
  args: {},
  handler: async (ctx) => {
    const limits = maximumLimits();

    const rootId = await ctx.db.insert(
      "assignments",
      newRootAssignment({
        subject: "alice",
        agent: "Main",
        threadId: "maximum",
        runTurn: "opaque",
        limits,
      }),
    );

    const runId = await ctx.db.insert(
      "runs",
      maximumRun({ rootAssignmentId: rootId, taskMessageId: "task-root" }),
    );

    await ctx.db.patch("assignments", rootId, { runId });
    const root = (await ctx.db.get("assignments", rootId))!;
    const budget = (await ctx.db.get("runs", runId))!;

    for (let i = 0; i < TREE_LIMITS.descendants; i++) await maximumChild(ctx, root, budget, i);

    await ctx.db.replace("assignments", rootId, padded(root, "runTurn", LIMITS.assignmentBytes));

    await ctx.db.patch("runs", runId, {
      startedAt: Date.now(),
      turnEndedAt: Date.now(),
      finishedAt: Date.now(),
    });

    return { threadId: root.threadId, rootRunId: runId };
  },
});

/** Seed one maximum-size descendant without weakening production metadata guards. */
async function maximumChild(
  ctx: MutationCtx,
  root: Doc<"assignments">,
  budget: Doc<"runs">,
  i: number,
) {
  const childId = await ctx.db.insert("assignments", {
    ...newRootAssignment({
      subject: "alice",
      agent: `Child-${i}`,
      threadId: `child-${i}`,
      runTurn: "opaque",
      limits: root.limits,
    }),
    rootAssignmentId: root._id,
    runId: budget._id,
  });

  const run = newSubagentRun({
    request: {
      agent: `Child-${i}`,
      payloadFingerprint: "hash",
      coordinateHandle: "opaque",
    },
    actor: root,
    root,
    budget,
    depth: 1,
    dedupKey: `dedup-${i}`,
    sequence: i + 1,
    now: Date.now(),
  });

  const childRunId = await ctx.db.insert("subagentRuns", {
    ...run,
    status: "completed",
    deliveryStatus: "accepted",
    childAssignmentId: childId,
    childThreadId: `child-${i}`,
    taskMessageId: `task-${i}`,
    startedAt: Date.now(),
    events: [{ phase: "completed", at: Date.now(), errorCode: null }],
  } satisfies Omit<Doc<"subagentRuns">, "_id" | "_creationTime">);

  await ctx.db.patch("assignments", childId, { childRunId });
  const assignment = (await ctx.db.get("assignments", childId))!;

  await ctx.db.replace(
    "assignments",
    childId,
    padded(assignment, "runTurn", LIMITS.assignmentBytes),
  );

  const child = (await ctx.db.get("subagentRuns", childRunId))!;

  await ctx.db.replace("subagentRuns", childRunId, padded(child, "payloadFingerprint", 4 << 10));
}

/** Assert the fixture really reaches its row caps, including native metadata. */
export const maximumSizes = query({
  args: { rootRunId: v.id("runs") },
  handler: async (ctx, { rootRunId }) => {
    const run = (await ctx.db.get("runs", rootRunId))!;

    const children = await ctx.db
      .query("subagentRuns")
      .withIndex("by_parent_run", (q) => q.eq("parentRunId", rootRunId))
      .take(TREE_LIMITS.descendants);

    const assignments = await Promise.all(
      [run.rootAssignmentId!, ...children.map((r) => r.childAssignmentId!)].map((id) =>
        ctx.db.get("assignments", id),
      ),
    );

    return { assignments: assignments.map(valueBytes), children: children.map(valueBytes) };
  },
});

/** Exercise lifecycle growth at the actual admission boundary in one transaction. */
export const envelopeLifecycle = mutation({
  args: { bytes: v.number(), failed: v.boolean() },
  handler: async (ctx, { bytes, failed }) => {
    const assignmentId = await ctx.db.insert(
      "assignments",
      newRootAssignment({
        subject: "alice",
        agent: "Main",
        threadId: "boundary",
        runTurn: "opaque",
        limits: resolveLimits(),
      }),
    );

    const metadata = {
      rootAssignmentId: assignmentId,
      rootCancellationEpoch: 0,
      taskMessageId: "task",
    };

    const settings = Array.from({ length: LIMITS.agents }, (_, i) => ({
      agent: String(i),
      settings: resolveRunSettings(),
    }));

    const models = {
      Main: "m".repeat(LIMITS.modelIdLength),
      Builder: "m".repeat(LIMITS.modelIdLength),
    };

    const base = newRun(models, settings, metadata);

    let padding = bytes - valueBytes(base);

    for (const entry of settings) {
      const added = Math.min(padding, LIMITS.requestKeyLength - entry.agent.length);

      entry.agent += "x".repeat(added);
      padding -= added;
    }

    if (padding !== 0) throw new Error("FIXTURE_PADDING_OVERFLOW");

    const runId = await ctx.db.insert("runs", newRun(models, settings, metadata));
    const root = (await ctx.db.get("assignments", assignmentId))!;

    await ctx.db.patch("runs", runId, {
      startedAt: Date.now(),
      resultMessageId: "m".repeat(64),
      launches: HOST_LIMITS.runLaunches.max,
      hops: HOST_LIMITS.runHops.max,
    });

    await ctx.db.patch("assignments", assignmentId, { runId, turnStatus: "idle" });
    const ended = { ...root, runId, turnStatus: "idle" as const };

    await endRootTurn(ctx, ended, failed ? "EXECUTION_AMBIGUOUS" : null);
    await closeRootRun(ctx, ended);

    return { bytes: valueBytes((await ctx.db.get("runs", runId))!), runId };
  },
});

/** A never-sent owned root, proving the public null envelope. */
export const emptyRoot = mutation({
  args: {},
  handler: (ctx) =>
    ctx.db.insert(
      "assignments",
      newRootAssignment({
        subject: "alice",
        agent: "Main",
        threadId: "empty",
        runTurn: "opaque",
        limits: resolveLimits(),
      }),
    ),
});

/** Model-free lifecycle fixture: terminal delivery gaps must still fence done. */
export const lifecycle = mutation({
  args: {
    assignmentId: v.id("assignments"),
    block: v.union(v.literal("delivery"), v.literal("ready"), v.literal("clear")),
  },
  handler: async (ctx, { assignmentId, block }) => {
    const root = (await ctx.db.get("assignments", assignmentId))!;
    const budget = (await ctx.db.get("runs", root.runId!))!;

    const members = await ctx.db
      .query("subagentRuns")
      .withIndex("by_parent_run", (q) => q.eq("parentRunId", budget._id))
      .take(TREE_LIMITS.descendants);

    for (const row of members) await ctx.db.delete("subagentRuns", row._id);

    const ready = await ctx.db
      .query("inbox")
      .withIndex("by_run_ready", (q) =>
        q.eq("assignmentId", root._id).eq("runId", budget._id).eq("passive", undefined),
      )
      .take(2);

    for (const row of ready) await ctx.db.delete("inbox", row._id);

    await ctx.db.patch("assignments", root._id, {
      turnStatus: "idle",
      turnToken: undefined,
      lastSlice: root.lastSlice ? { ...root.lastSlice, active: false } : undefined,
      inboxId: undefined,
    });

    await endRootTurn(ctx, root, null);

    if (block === "ready")
      await ctx.db.insert("inbox", {
        assignmentId,
        messageId: "ready",
        sequence: 1,
        runId: budget._id,
        kind: "result",
      });
    else if (block !== "clear")
      await ctx.db.insert("subagentRuns", {
        ...newSubagentRun({
          request: { agent: "Builder", payloadFingerprint: "hash", coordinateHandle: "opaque" },
          actor: root,
          root,
          budget,
          depth: 1,
          dedupKey: "gap",
          sequence: 1,
          now: Date.now(),
        }),
        status: "completed",
        deliveryStatus: block === "delivery" ? "pending" : "failed",
      });

    await closeRootRun(ctx, { ...root, turnStatus: "idle" });

    return null;
  },
});
