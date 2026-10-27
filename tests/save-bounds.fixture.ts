/** Exact assignment boundary before a genuine nested native save, and the
 * largest assignment row production's writer bounds admit. */
import { getConvexSize, v } from "convex/values";
import type { Id } from "../src/component/_generated/dataModel.js";
import { mutation } from "../src/component/_generated/server.js";
import { newRootAssignment } from "../src/component/turns/assignments.js";
import { newRun } from "../src/component/turns/runs.js";
import { newDoneReceipt } from "../src/component/receipts/records.js";
import { validModelOverrides } from "../src/component/models.js";
import { HOST_LIMITS, LIMITS, resolveLimits } from "../src/component/limits.js";
import { fillAssignment, fullReport } from "./assignment-envelope.fixture.js";

export const seed = mutation({
  args: {
    threadId: v.string(),
    promptMessageId: v.string(),
    marker: v.boolean(),
    overflow: v.boolean(),
  },
  handler: async (ctx, args) => {
    const id = await ctx.db.insert("assignments", {
      ...newRootAssignment({
        subject: "alice",
        agent: "Main",
        threadId: args.threadId,
        runTurn: "opaque",
        limits: resolveLimits(),
      }),
      turnToken: "save",
      turnStatus: "running",
      promptMessageId: args.promptMessageId,
      turnReport: {
        promptMessageId: args.promptMessageId,
        maxMessages: 64,
        messageIds: Array.from({ length: 63 }, () => "m".repeat(LIMITS.messageIdBytes)),
      },
      ...(args.marker
        ? {
            activeTools: Array.from({ length: 16 }, (_, i) => ({
              key: String(i).padStart(64, "0"),
              name: "n".repeat(128),
            })),
          }
        : {}),
    });

    if (args.marker) await fillAssignment(ctx, id);
    else {
      const row = (await ctx.db.get("assignments", id))!;

      // Native test ids have the same encoding length as this real prompt id.
      const after = {
        ...row,
        turnReport: {
          ...row.turnReport!,
          messageIds: [...row.turnReport!.messageIds, args.promptMessageId],
        },
      };

      const growth = LIMITS.assignmentBytes + Number(args.overflow) - getConvexSize(after);

      await ctx.db.patch("assignments", id, { runTurn: row.runTurn + "x".repeat(growth) });
    }

    return id;
  },
});

// The largest assignment production can write: every host string at its writer
// bound, every list at its count cap and every literal at its longest member.
const wide = "語"; // 3 UTF-8 bytes, 1 UTF-16 unit.
const handle = "h".repeat(LIMITS.functionHandleBytes);
const nativeId = (seed: string | number) => String(seed).padStart(LIMITS.messageIdBytes, "n");

const name = (seed: number) =>
  wide.repeat(LIMITS.nameLength - 1) + String.fromCharCode(0x4e00 + seed);

/** The largest `n` whose built value still passes `fits` (monotone in n). */
function largest<T>(build: (n: number) => T, fits: (value: T) => boolean, high: number) {
  let low = 0;

  while (low < high) {
    const mid = Math.ceil((low + high) / 2);

    if (fits(build(mid))) low = mid;
    else high = mid - 1;
  }

  return build(low);
}

/** The biggest model map `validModelOverrides` admits (<=512 Convex bytes). */
function largestModels() {
  return largest((n) => ({ m: wide.repeat(n) }), validModelOverrides, LIMITS.modelIdLength);
}

/** Native metadata handles are the only stored text configuration. */
function textFields() {
  return {
    textConfig: {
      worker: handle,
      updateThread: handle,
      getThread: handle,
    },
  };
}

/** A full 16-call approval pause with every optional flag set. */
function approvalFields(inboxId: Id<"inbox">, proposalId: Id<"receipts">) {
  return {
    approvals: {
      inboxId,
      epoch: 2 ** 52,
      getMessages: handle,
      addMessages: handle,
      cleanupPending: true,
      requests: Array.from({ length: LIMITS.approvalsPerPause }, (_, i) => ({
        deferred: true,
        key: "k".repeat(64),
        messageId: nativeId(`a${i}`),
        proposalId,
        providerExecuted: true,
        toolCallKey: new ArrayBuffer(32),
        resolved: true as const,
        effective: true,
      })),
    },
  };
}

export const largestRow = mutation({
  args: {},
  handler: async (ctx) => {
    const id = await ctx.db.insert(
      "assignments",
      newRootAssignment({
        subject: name(0),
        agent: name(0),
        threadId: nativeId("thread"),
        runTurn: handle,
        limits: resolveLimits(),
      }),
    );

    const runId = await ctx.db.insert("runs", newRun({}));
    const execution = `${id}:${Number.MAX_SAFE_INTEGER}`;

    const inboxId = await ctx.db.insert("inbox", {
      assignmentId: id,
      messageId: nativeId("i"),
      sequence: 0,
      kind: "user",
      runId,
    });

    const proposalId = await ctx.db.insert(
      "receipts",
      newDoneReceipt({ scope: "s", key: "k", fingerprint: "f", result: null }),
    );

    await ctx.db.patch("assignments", id, {
      ...textFields(),
      ...approvalFields(inboxId, proposalId),
      notesPending: 2 ** 52,
      models: largestModels(),
      workflowId: nativeId("w"),
      limits: resolveLimits(
        Object.fromEntries(
          Object.entries(HOST_LIMITS).map(([k, limit]) => [k, limit.max]),
        ) as never,
      ),
      wakeEventId: nativeId("e"),
      modelSteps: 2 ** 52,
      pendingGeneration: {
        messageId: nativeId("p"),
        executionId: execution,
        epoch: 2 ** 52,
        getMessages: handle,
        finalizeMessage: handle,
        failMessage: handle,
        stream: { id: nativeId("stream"), abort: handle },
      },
      cancellationEpoch: 2 ** 52,
      runId,
      childRunId: crypto.randomUUID(),
      rootAssignmentId: id,
      turnStatus: "recovery_required",
      errorCode: "AUTHORIZATION_DENIED",
      queuedMessages: 2 ** 52,
      nextSequence: 2 ** 52,
      nextTurn: 2 ** 52,
      turnToken: execution,
      promptMessageId: nativeId("prompt"),
      turnReport: fullReport(inboxId),
      turnOrigin: "subagent_result",
      inboxId,
      lastSlice: { id: `${execution}/${HOST_LIMITS.slicesPerTurn.max}`, active: true },
      activeRuns: 2 ** 52,
      nextRunSequence: 2 ** 52,
    });

    return id;
  },
});
