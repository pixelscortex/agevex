/**
 * `turns.slices.write`: the transactional fence around every native Agent write and
 * host tool mutation made by a running turn.
 *
 * The host action never writes native history directly. It hands the native
 * mutation handle and args to `write`, which checks the execution token,
 * cancellation epoch and (for children) the root epoch, then runs the native
 * mutation as a nested call in the SAME transaction: cancellation either wins
 * or the write commits first, with no race. Around native message saves it
 * also records coordination facts atomically: the exact message refs, the
 * usage step, the child's final result id, the pending generation and stream,
 * and any approval pause (turns/pause.ts). Touches `assignments`,
 * `subagentRuns.childResultMessageId` and `inbox`.
 */
import type { MessageDoc } from "@convex-dev/agent";
import type { FunctionHandle } from "convex/server";
import { ConvexError, v, type ObjectType } from "convex/values";
import { internal } from "../_generated/api.js";
import type { MutationCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
import { LIMITS } from "../limits.js";
import { prepareDecisions, oversizedDecisionInput } from "./decision-save.js";
import { recordMessages } from "../hooks/refs.js";
import { runById } from "../subagents/runs.js";
import { disarmRecovery } from "./recovery.js";
import { disarmSlice } from "./boundaries.js";
import { deferChildFailure, failChild, markRecoveryRequired } from "./finish.js";
import {
  collectPause,
  countPauseRequests,
  retireConsumedApprovals,
  suspendForApprovals,
} from "./pause.js";

export const writeArgs = {
  assignmentId: v.id("assignments"),
  executionId: v.string(),
  cancellationEpoch: v.number(),
  handle: v.string(),
  args: v.any(),
  rejectStale: v.optional(v.boolean()),
  nativeStream: v.optional(v.string()),
  trackUsage: v.optional(v.boolean()),
  deferredTools: v.optional(v.array(v.string())),
  askUserTools: v.optional(
    v.record(
      v.string(),
      v.object({
        calls: v.array(
          v.object({
            toolCallId: v.string(),
            input: v.optional(v.any()),
            answerSchema: v.optional(v.any()),
            error: v.optional(v.string()),
          }),
        ),
      }),
    ),
  ),
  nativeMessages: v.optional(
    v.object({
      getMessages: v.string(),
      finalizeMessage: v.string(),
    }),
  ),
};

type WriteArgs = ObjectType<typeof writeArgs>;

/** Run one native/tool mutation under the execution fence and record its
 * coordination facts. Returns the native mutation's result, or null (or a
 * typed CANCELLED error with `rejectStale`) when the caller lost the turn. */
export async function fencedWrite(ctx: MutationCtx, args: WriteArgs): Promise<unknown> {
  const loaded = await ctx.db.get("assignments", args.assignmentId);
  const row = await liveWriter(ctx, loaded, args);

  if (!row) return staleWrite(ctx, loaded, args);

  const deferredTools = new Set(args.deferredTools ?? []);

  if (
    deferredTools.size > LIMITS.approvalsPerPause ||
    [...deferredTools].some((name) => !name || name.length > LIMITS.requestKeyLength)
  )
    throw new Error("INVALID_DEFERRED_TOOLS");

  if (args.nativeMessages) await prepareDecisions(ctx, row, args.args, args.askUserTools);

  if (
    args.nativeMessages &&
    (countPauseRequests(args.args.messages, deferredTools) > LIMITS.approvalsPerPause ||
      oversizedDecisionInput(
        args.args.messages,
        deferredTools,
        { threadId: row.threadId, agent: row.agent },
        args.askUserTools,
      ))
  )
    return rejectApprovalOverflow(ctx, row);

  const result = await ctx.runMutation(args.handle as FunctionHandle<"mutation">, args.args);

  if (args.nativeMessages) {
    const messages = (result as { messages: MessageDoc[] }).messages;

    await recordNativeSave(ctx, row, args, messages, deferredTools);
  }

  if (args.nativeStream) await trackStream(ctx, row, args, result as string);

  return result;
}

/** The row if the caller still owns a running turn at its token and epoch,
 * else null. A child can settle immediately before cancel, while its source
 * action still owns the turn token. It no longer occupies an active slot, so
 * cancel need not visit its assignment. The root epoch still fences every
 * late native/tool write: two <=32 KiB assignment reads plus one <=4 KiB
 * child-run reference (<72 KiB), no traversal. */
async function liveWriter(ctx: MutationCtx, row: Doc<"assignments"> | null, args: WriteArgs) {
  const root = row?.rootAssignmentId ? await ctx.db.get("assignments", row.rootAssignmentId) : null;
  const run = row?.childRunId ? await runById(ctx, row.childRunId) : null;

  const rootRevoked =
    !!row?.childRunId &&
    (!root || root.cancelled || !run || run.rootCancellationEpoch !== root.cancellationEpoch);

  if (
    !row ||
    row.cancelled ||
    rootRevoked ||
    row.turnStatus !== "running" ||
    row.turnToken !== args.executionId ||
    row.cancellationEpoch !== args.cancellationEpoch
  )
    return null;

  return row;
}

/** A write from a turn that lost its fence. The one stale write allowed is
 * failing this execution's own pending placeholder (cancellation.cleanup.close);
 * everything else is refused or silently dropped. */
async function staleWrite(ctx: MutationCtx, row: Doc<"assignments"> | null, args: WriteArgs) {
  const pending = row?.pendingGeneration;

  if (
    pending &&
    pending.executionId === args.executionId &&
    pending.epoch === args.cancellationEpoch &&
    pending.finalizeMessage === args.handle &&
    args.args?.messageId === pending.messageId &&
    args.args?.result?.status === "failed"
  )
    return ctx.runMutation(internal.cancellation.cleanup.close, {
      assignmentId: args.assignmentId,
      executionId: args.executionId,
      epoch: args.cancellationEpoch,
      messageId: pending.messageId,
    });

  if (args.rejectStale) throw new ConvexError({ code: "CANCELLED" });

  return null; // Agent's asynchronous void abort listeners must resolve.
}

/** Reject the entire step BEFORE its native save: overflow approvals must
 * never exist without bounded coordination references. Return null so
 * this typed failure commits; throwing would roll it back. The SDK
 * stops on the rejected save, and its stale finish cannot overwrite it. */
async function rejectApprovalOverflow(ctx: MutationCtx, row: Doc<"assignments">) {
  await disarmSlice(ctx, row);
  await disarmRecovery(ctx, row);

  if (await deferChildFailure(ctx, row, "APPROVAL_LIMIT")) return null;

  await failChild(ctx, row, "APPROVAL_LIMIT");
  await markRecoveryRequired(ctx, row, "APPROVAL_LIMIT");

  await ctx.db.patch("assignments", row._id, {
    turnToken: undefined,
  });

  return null;
}

/** Coordination facts recorded with a native message save, in order: exact
 * refs, the usage step, retired approvals, the child's final result, the
 * pending generation, and finally any new approval pause. */
async function recordNativeSave(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  args: WriteArgs,
  messages: MessageDoc[],
  deferredTools: Set<string>,
) {
  // Agent 0.7.7 addMessages returns the actual pending document, including
  // its id (vercel/client/saveInputMessages.ts). Record only coordination
  // metadata in the SAME transaction as the native placeholder creation.
  await recordMessages(ctx, row, messages);

  const modelStep =
    args.trackUsage || row.textConfig?.summary
      ? messages.find((message) => message.usage && message.status === "success")
      : undefined;

  if (modelStep)
    await ctx.db.patch("assignments", row._id, {
      modelStep: { messageId: String(modelStep._id), stepOrder: modelStep.stepOrder },
    });

  // Claiming a continuation never consumes a decision: cancel can still
  // win while the tool/provider awaits I/O. Retire only with its native save.
  // Agent 0.7.7 src/vercel/client/prepareApprovalContext.ts:23-30 treats a
  // subsequent assistant response as consumption of provider-owned decisions,
  // even without a tool-result. Pending placeholders are not responses.
  if (row.approvals) await retireConsumedApprovals(ctx, row, messages);

  await recordResult(ctx, row, messages);

  await trackPendingGeneration(ctx, row, args, messages);

  const pause = await collectPause(ctx, messages, deferredTools, args.askUserTools);

  if (pause.count)
    await suspendForApprovals(ctx, row, pause, {
      getMessages: args.nativeMessages!.getMessages,
      addMessages: args.handle,
    });
}

/** Capture the exact last successful non-empty assistant message with its native
 * save. Root history must never reuse a modelStep from a previous user request;
 * the child's candidate is still verified by settlement before delivery. */
async function recordResult(ctx: MutationCtx, row: Doc<"assignments">, messages: MessageDoc[]) {
  const finals = messages.filter(
    (message) =>
      message.message?.role === "assistant" && message.status === "success" && message.text?.trim(),
  );

  const final = finals[finals.length - 1];

  if (!final) return;

  if (!row.childRunId) {
    if (row.runId) await ctx.db.patch("runs", row.runId, { resultMessageId: final._id });

    return;
  }

  const run = await runById(ctx, row.childRunId);

  if (run) await ctx.db.patch("subagentRuns", run._id, { childResultMessageId: final._id });
}

/** Track the one pending (streaming) placeholder this save created, so cancel
 * can fail it, or clear the tracked one when this save finalized it. */
async function trackPendingGeneration(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  args: WriteArgs,
  messages: MessageDoc[],
) {
  const pending = messages.filter((message) => message.status === "pending");

  if (pending.length > 1) throw new Error("MULTIPLE_PENDING_GENERATIONS");

  if (pending.length)
    await ctx.db.patch("assignments", row._id, {
      pendingGeneration: {
        messageId: pending[0]._id,
        executionId: args.executionId,
        epoch: args.cancellationEpoch,
        ...args.nativeMessages!,
      },
    });
  else if (row.pendingGeneration?.messageId === args.args?.pendingMessageId)
    await ctx.db.patch("assignments", row._id, { pendingGeneration: undefined });
}

/** Attach the native stream id to this execution's tracked placeholder, so
 * cancellation cleanup can abort that exact stream. `row` is the snapshot
 * read at the start of this write. */
async function trackStream(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  args: WriteArgs,
  streamId: string,
) {
  const pending = row.pendingGeneration;

  if (
    !pending ||
    pending.executionId !== args.executionId ||
    pending.epoch !== args.cancellationEpoch
  )
    throw new Error("UNTRACKED_GENERATION_STREAM");

  await ctx.db.patch("assignments", row._id, {
    pendingGeneration: {
      ...pending,
      stream: { id: streamId, abort: args.nativeStream! },
    },
  });
}
