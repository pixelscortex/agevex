/** Exact assignment boundary before a genuine nested native save, and the
 * largest assignment row production's writer bounds admit. */
import { getConvexSize, v } from "convex/values";
import { internal } from "../src/component/_generated/api.js";
import type { Id } from "../src/component/_generated/dataModel.js";
import { mutation } from "../src/component/_generated/server.js";
import { newRootAssignment } from "../src/component/turns/assignments.js";
import { newRun } from "../src/component/turns/runs.js";
import { newDoneReceipt } from "../src/component/receipts/records.js";
import { validModelOverrides } from "../src/component/models.js";
import { TEXT_LIMITS, validText } from "../src/component/text/values.js";
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
        modelStep: { messageId: args.promptMessageId, stepOrder: 0 },
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

/** The biggest summary `validText` admits, in ASCII or 3-byte UTF-8. */
function largestSummary() {
  const fits = (text: string) => validText(text, "summary");

  return [
    largest((n) => "a".repeat(n), fits, TEXT_LIMITS.summaryBytes),
    largest((n) => wide.repeat(n), fits, TEXT_LIMITS.summaryBytes),
  ].sort((a, b) => getConvexSize(b) - getConvexSize(a))[0];
}

/** The biggest model map `validModelOverrides` admits (<=512 Convex bytes). */
function largestModels() {
  return largest((n) => ({ m: wide.repeat(n) }), validModelOverrides, LIMITS.modelIdLength);
}

/** Root text metadata: handles, both jobs, the boundary and the full summary. */
function textFields(runId: Id<"runs">) {
  const boundary = { id: nativeId("b"), order: 2 ** 52, stepOrder: 2 ** 52, sequence: 2 ** 52 };

  const job = {
    key: crypto.randomUUID(),
    runId,
    epoch: 2 ** 52,
    version: 2 ** 52,
    status: "running" as const,
    dispatched: true,
    again: runId,
    deferred: true,
    titleRef: { id: nativeId("t"), order: 2 ** 52, stepOrder: 2 ** 52, bytes: 2 ** 52 },
  };

  return {
    textConfig: {
      worker: handle,
      updateThread: handle,
      getThread: handle,
      title: true,
      summary: true,
      everyTurns: TEXT_LIMITS.everyTurns,
    },
    titleVersion: 2 ** 52,
    titleSource: "auto" as const,
    titleTask: job,
    summaryTask: job,
    textCompleted: boundary,
    textSummary: { text: largestSummary(), through: boundary },
  };
}

/** A full 16-call approval pause with every optional flag set. */
function approvalFields(inboxId: Id<"inbox">, proposalId: Id<"receipts">) {
  return {
    approvalBlocked: true,
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

/** Exact-id references: the context ring, every side review and the usage step. */
function referenceFields() {
  return {
    modelStep: { messageId: nativeId("s"), stepOrder: 2 ** 52 },
    contextMessages: Array.from({ length: LIMITS.contextMessages }, (_, i) => ({
      id: nativeId(`c${i}`),
      order: 2 ** 52,
      stepOrder: 2 ** 52,
      bytes: 2 ** 52,
      sequence: 2 ** 52,
    })),
    reviewed: Array.from({ length: LIMITS.sideAgents }, (_, i) => ({
      agent: name(i + 1),
      turn: 2 ** 52,
      at: 2 ** 52,
      boundary: 2 ** 52,
    })),
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

    const jobId = await ctx.scheduler.runAfter(
      LIMITS.receiptRetentionMs,
      internal.turns.failures.stalled,
      {
        assignmentId: id,
        turnToken: execution,
      },
    );

    await ctx.db.patch("assignments", id, {
      ...textFields(runId),
      ...referenceFields(),
      ...approvalFields(inboxId, proposalId),
      completedTurns: 2 ** 52,
      notesPending: 2 ** 52,
      routingAgentIndex: 63,
      hookContinue: true,
      models: largestModels(),
      workflowId: nativeId("w"),
      limits: resolveLimits(
        Object.fromEntries(
          Object.entries(HOST_LIMITS).map(([k, limit]) => [k, limit.max]),
        ) as never,
      ),
      loopWaiting: true,
      pinged: true,
      recoveryAt: 2 ** 52,
      recoveryJobId: jobId,
      recoveryDelayMs: 2 ** 52,
      modelSteps: 2 ** 52,
      watchdogId: jobId,
      pendingGeneration: {
        messageId: nativeId("p"),
        executionId: execution,
        epoch: 2 ** 52,
        getMessages: handle,
        finalizeMessage: handle,
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
      lastSlice: `${execution}/${HOST_LIMITS.slicesPerTurn.max}`,
      activeRuns: 2 ** 52,
      nextRunSequence: 2 ** 52,
    });

    return id;
  },
});
