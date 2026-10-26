/** Component-local adversarial fixtures; these handlers never ship in core. */
import { v, getConvexSize, type Value } from "convex/values";
import type { Doc } from "../src/component/_generated/dataModel.js";
import { mutation, type MutationCtx } from "../src/component/_generated/server.js";
import { newRootAssignment } from "../src/component/turns/assignments.js";
import { newRun } from "../src/component/turns/runs.js";
import { newSubagentRun } from "../src/component/subagents/runs.js";
import { HOST_LIMITS, LIMITS, resolveLimits } from "../src/component/limits.js";
import { TREE_LIMITS, taskPreview } from "../src/component/run-tree-values.js";
import { resolveRunSettings } from "../src/component/run-settings.js";
import { closeRootRun, endRootTurn } from "../src/component/turns/run-lifecycle.js";

/** Fill opaque handles/fingerprints, never returned content, to their row caps. */
function padded<T extends Record<string, Value | undefined>>(
  row: T,
  field: keyof T,
  bytes: number,
) {
  const size = Math.max(getConvexSize(row), new TextEncoder().encode(JSON.stringify(row)).length);

  return { ...row, [field]: "x".repeat(bytes - size - 256) };
}

export const seedMaximum = mutation({
  args: {},
  handler: async (ctx) => {
    const limits = resolveLimits(
      Object.fromEntries(Object.entries(HOST_LIMITS).map(([key, bound]) => [key, bound.max])),
    );

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
      newRun(
        undefined,
        Array.from({ length: LIMITS.agents }, (_, i) => ({
          agent: `${i}`.padEnd(100, "a"),
          settings: resolveRunSettings(),
        })),
        {
          rootAssignmentId: rootId,
          taskMessageId: "task-root",
          taskPreview: taskPreview("界".repeat(256)),
        },
      ),
    );

    await ctx.db.patch("assignments", rootId, { runId });
    const root = (await ctx.db.get("assignments", rootId))!;
    const budget = (await ctx.db.get("runs", runId))!;

    for (let i = 0; i < TREE_LIMITS.descendants; i++) await maximumChild(ctx, root, budget, i);

    const { _id, _creationTime, ...rootRow } = root;

    await ctx.db.replace("assignments", rootId, padded(rootRow, "runTurn", LIMITS.assignmentBytes));

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
  const childId = await ctx.db.insert(
    "assignments",
    padded(
      {
        ...newRootAssignment({
          subject: "alice",
          agent: `Child-${i}`,
          threadId: `child-${i}`,
          runTurn: "opaque",
          limits: root.limits,
        }),
        rootAssignmentId: root._id,
        runId: budget._id,
        childRunId: `node-${i}`,
      },
      "runTurn",
      LIMITS.assignmentBytes,
    ),
  );

  const run = newSubagentRun({
    request: {
      agent: `Child-${i}`,
      side: i >= root.limits.runLaunches || undefined,
      payloadFingerprint: "hash",
      coordinateHandle: "opaque",
    },
    runId: `node-${i}`,
    actor: root,
    root,
    budget,
    depth: 1,
    wait: "each",
    group: undefined,
    dedupKey: `dedup-${i}`,
    sequence: i + 1,
    now: Date.now(),
  });

  await ctx.db.insert(
    "subagentRuns",
    padded(
      {
        ...run,
        status: "completed",
        deliveryStatus: "accepted",
        childAssignmentId: childId,
        childThreadId: `child-${i}`,
        taskMessageId: `task-${i}`,
        taskPreview: taskPreview("界".repeat(256)),
        startedAt: Date.now(),
        events: [{ phase: "completed", at: Date.now(), errorCode: null }],
      } satisfies Omit<Doc<"subagentRuns">, "_id" | "_creationTime">,
      "payloadFingerprint",
      4 << 10,
    ),
  );
}

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
    block: v.union(
      v.literal("delivery"),
      v.literal("group"),
      v.literal("ready"),
      v.literal("clear"),
    ),
  },
  handler: async (ctx, { assignmentId, block }) => {
    const root = (await ctx.db.get("assignments", assignmentId))!;
    const budget = (await ctx.db.get("runs", root.runId!))!;

    const members = await ctx.db
      .query("subagentRuns")
      .withIndex("by_group", (q) => q.eq("parentRunId", budget._id))
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
      watchdogId: undefined,
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
          runId: "gap",
          actor: root,
          root,
          budget,
          depth: 1,
          wait: "each",
          group: undefined,
          dedupKey: "gap",
          sequence: 1,
          now: Date.now(),
        }),
        status: "completed",
        deliveryStatus: block === "delivery" ? "pending" : "failed",
        ...(block === "group" ? { join: "sealed" as const } : {}),
      });

    await closeRootRun(ctx, { ...root, turnStatus: "idle" });

    return null;
  },
});
