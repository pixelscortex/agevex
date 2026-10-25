/**
 * The native side of cancellation cleanup, one bounded step at a time.
 *
 * `failPendingGeneration` aborts an execution's tracked stream and fails its
 * pending placeholder message (`finalize`, also used by `close`).
 * `denyFirstRequest` closes the first recorded approval/deferred request of a
 * cancelled pause with native "execution-denied" results (and a denial for
 * an undecided approval), reading exactly one native message. Then
 * `continueOrRelease` chains the next cleanup job or releases the pause.
 * Called only by cancellation.ts. Touches `assignments.approvals`; native
 * writes go through the recorded Agent handles.
 */
import type { FunctionHandle } from "convex/server";
import type { MessageDoc } from "@convex-dev/agent";
import type { MutationCtx } from "../_generated/server.js";
import { internal } from "../_generated/api.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import type { pendingGeneration } from "../schema.js";
import { approvalKey, saveResponses } from "../approvals.js";
import { wake } from "../queue/wake.js";

type PendingGeneration = typeof pendingGeneration.type;
type Approvals = NonNullable<Doc<"assignments">["approvals"]>;

/** Exactly one recorded placeholder per transaction, including native payload reads. */
export async function finalize(ctx: MutationCtx, pending: PendingGeneration) {
  const [message]: ({ status: string } | null)[] = await ctx.runQuery(
    pending.getMessages as FunctionHandle<"query">,
    { messageIds: [pending.messageId] },
  );
  // Native ids survive order reuse. Deletion and an already terminal message
  // are both no-ops; finalizeMessage also compares pending status atomically.
  if (message?.status === "pending")
    await ctx.runMutation(pending.finalizeMessage as FunctionHandle<"mutation">, {
      messageId: pending.messageId,
      result: { status: "failed", error: "CANCELLED" },
    });
}

/** Abort the execution's tracked stream (if any), then fail its placeholder. */
export async function failPendingGeneration(ctx: MutationCtx, pending: PendingGeneration) {
  // Stream creation is tracked atomically too: never list a thread's streams
  // after cancellation, when a fresh generation may already own another one.
  if (pending.stream) {
    try {
      await ctx.runMutation(pending.stream.abort as FunctionHandle<"mutation">, {
        streamId: pending.stream.id,
        reason: "CANCELLED",
      });
    } catch (error) {
      // Native deletion may already have removed this exact stream.
      if (
        !(error instanceof Error) ||
        !error.message.includes("Stream not found: " + pending.stream.id)
      )
        throw error;
    }
  }

  await finalize(ctx, pending);
}

/** Close the first recorded request natively: an "execution-denied" result
 * for its call and, for an undecided approval, a denial response. */
export async function denyFirstRequest(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  approvals: Approvals,
) {
  const request = approvals.requests[0];
  const messageId = request.messageId;
  // One exact request document per transaction (<= 1 MiB), plus native save
  // lookups and at most one placeholder/stream: never read sixteen huge docs
  // together. Chained jobs settle <= approvalsPerPause recorded requests in
  // total; the guard remains set until the final native save commits.
  const [message]: (MessageDoc | null)[] = await ctx.runQuery(
    approvals.getMessages as FunctionHandle<"query">,
    { messageIds: [messageId] },
  );

  const { responses, deniedCalls } = await cancelledDecision(message, request);
  if (deniedCalls.length)
    await saveResponses(
      ctx,
      { ...row, messageId, addMessages: approvals.addMessages },
      responses,
      deniedCalls,
    );
}

/** The native parts that cancel the request's call: the matching deferred
 * tool call, or the approval request with its call (denying it too when it
 * was never decided). Empty when the native message no longer holds it. */
async function cancelledDecision(
  message: MessageDoc | null,
  request: Approvals["requests"][number],
) {
  const content = message?.message?.content;
  const responses = [];
  const deniedCalls = [];
  if (message?.message?.role === "assistant" && Array.isArray(content)) {
    for (const part of content) {
      if (request.deferred) {
        if (part.type === "tool-call" && (await approvalKey(part.toolCallId)) === request.key) {
          deniedCalls.push({ toolCallId: part.toolCallId, toolName: part.toolName });
          break;
        }
        continue;
      }
      if (part.type !== "tool-approval-request") continue;
      const key = await approvalKey(part.approvalId);
      if (key !== request.key) continue;
      const call = content.find(
        (candidate) => candidate.type === "tool-call" && candidate.toolCallId === part.toolCallId,
      );
      if (call?.type !== "tool-call") throw new Error("APPROVAL_CALL_NOT_FOUND");
      // Even an answered request has no result until the gated continuation
      // runs. Cancel terminates that call without repeating its decision.
      deniedCalls.push({
        toolCallId: part.toolCallId,
        toolName: call.toolName,
        ...(request.providerExecuted ? { providerExecuted: true as const } : {}),
      });
      if (!request.resolved)
        responses.push({
          approvalId: part.approvalId,
          approved: false,
          reason: "cancelled",
          ...(request.providerExecuted ? { providerExecuted: true as const } : {}),
        });
      break;
    }
  }
  return { responses, deniedCalls };
}

/** Drop the handled request; chain the next cleanup job, or release the
 * pause and wake the (cancelled) assignment when none remain. */
export async function continueOrRelease(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  approvals: Approvals,
  approvalEpoch: number | undefined,
) {
  const assignmentId: Id<"assignments"> = row._id;
  // Native deletion is also terminal for this exact reference. Never search
  // another order/message for a replacement after cancellation.
  const remaining = approvals.requests.slice(1);
  if (remaining.length) {
    await ctx.db.patch("assignments", assignmentId, {
      approvals: { ...approvals, requests: remaining },
    });
    await ctx.scheduler.runAfter(0, internal.cancellation.cleanup, {
      assignmentId,
      approvalEpoch,
    });
  } else {
    await ctx.db.patch("assignments", assignmentId, {
      approvals: undefined,
      approvalBlocked: false,
    });
    await wake(ctx, { ...row, approvals: undefined, approvalBlocked: false });
  }
}
