/**
 * Resolving an approval pause: `respond` (approve/deny a tool approval
 * request) and `answer` (supply the result of a deferred tool call).
 *
 * Each response saves its native message and an idempotency receipt in one
 * transaction, marks or removes the matching recorded request, points the
 * pause's continuation inbox row at the newest saved message, and wakes the
 * assignment once nothing is left undecided. An identical retry replays from
 * the receipt (`replayed: true`); a different payload for the same call is a
 * KEY_CONFLICT. Touches `assignments.approvals`, `inbox` and `receipts`.
 */
import type { MessageDoc } from "@convex-dev/agent";
import type { FunctionHandle } from "convex/server";
import { ConvexError, getConvexSize, v } from "convex/values";
import { type MutationCtx, mutation } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { LIMITS } from "../limits.js";
import { approvalKey, saveResponses } from "../approvals.js";
import { armPurge, findReceipt, newDoneReceipt } from "../receipts/records.js";
import { wake } from "./wake.js";

/** `replayed` is true when an identical retry was served from the response
 * receipt, so a host can tell a first decision from a replay (e.g. to record
 * single-use consent only once). */
export const vResponseResult = v.object({ messageId: v.string(), replayed: v.boolean() });

type ResponseReceipt = { scope: string; key: string; fingerprint: string };

/**
 * Native responses commit once with their receipt, so a lost host response can
 * replay even after the pending-call reference has been consumed. Hash the
 * tuple and payload instead of copying potentially near-1 MiB native ids or
 * answer/reason text into the ledger; JSON framing keeps tuple parts distinct.
 * The indexed lookup reads one <=64 KiB result plus fixed-size metadata. Saving
 * adds one expiry-head read and one receipt write of the same bound: <256 KiB
 * total additional I/O, independent of the <=16 calls in a pause. Together with
 * answer's <13 MiB native/readiness budget below, this remains <13.25 MiB.
 */
async function responseReceipt(
  ctx: MutationCtx,
  scope: "answer" | "respond",
  threadId: string,
  callId: string,
  payload: string,
) {
  const key = await approvalKey(JSON.stringify([threadId, callId]));
  const fingerprint = await approvalKey(payload);
  const receipt = await findReceipt(ctx, scope, key);

  if (receipt && receipt.fingerprint !== fingerprint)
    throw new ConvexError({ code: "KEY_CONFLICT" });

  return { scope, key, fingerprint, messageId: receipt?.result as string | undefined };
}

async function saveResponseReceipt(ctx: MutationCtx, receipt: ResponseReceipt, messageId: string) {
  // Keep the same result bound and seven-day purge lifecycle as tool/request
  // receipts. The saved native message remains the only copy of the payload.
  if (getConvexSize(messageId) > LIMITS.receiptResultBytes) throw new Error("RESULT_TOO_LARGE");

  await armPurge(ctx);
  await ctx.db.insert("receipts", newDoneReceipt({ ...receipt, result: messageId }));
}

/** Approval responses MUST go through the authorized respond endpoint. A
 * response saved directly through Agent is not seen by this runtime.
 * Saves the native approval response, marks the request resolved, and once
 * every request is resolved releases the pause into its continuation turn. */
export async function respondToApproval(
  ctx: MutationCtx,
  args: {
    assignmentId: Id<"assignments">;
    subject: string;
    approvalId: string;
    approved: boolean;
    reason?: string;
    addMessages: string;
  },
) {
  const row = await ctx.db.get("assignments", args.assignmentId);

  if (!row || row.subject !== args.subject) throw new ConvexError({ code: "FORBIDDEN" });

  const receipt = await responseReceipt(
    ctx,
    "respond",
    row.threadId,
    args.approvalId,
    JSON.stringify([args.approved, args.reason ?? null]),
  );

  if (receipt.messageId !== undefined) return { messageId: receipt.messageId, replayed: true };

  const approvals = row.approvals;
  const key = await approvalKey(args.approvalId);

  const index =
    approvals?.requests.findIndex((request) => !request.deferred && request.key === key) ?? -1;

  const decision = approvals?.requests[index];

  if (!row.approvalBlocked || row.cancelled || !approvals || approvals.cleanupPending || !decision)
    throw new ConvexError({ code: "APPROVAL_NOT_FOUND" });

  if (decision.resolved) throw new ConvexError({ code: "APPROVAL_ALREADY_RESOLVED" });

  const messageId = await saveResponses(
    ctx,
    { ...row, messageId: decision.messageId, addMessages: args.addMessages },
    [
      {
        approvalId: args.approvalId,
        approved: args.approved,
        ...(args.reason !== undefined ? { reason: args.reason } : {}),
        ...(decision.providerExecuted ? { providerExecuted: true as const } : {}),
      },
    ],
  );

  await saveResponseReceipt(ctx, receipt, messageId);

  const requests = approvals.requests.map((request, offset) =>
    offset === index ? { ...request, resolved: true as const } : request,
  );

  await ctx.db.patch("assignments", row._id, { approvals: { ...approvals, requests } });

  if (requests.every((request) => request.resolved)) {
    await ctx.db.patch("inbox", approvals.inboxId, { messageId });
    await ctx.db.patch("assignments", row._id, { approvalBlocked: false });
    await wake(ctx, { ...row, approvalBlocked: false });
  }

  return { messageId, replayed: false };
}

/** Save a deferred native result and release its continuation atomically.
 * One exact <=1 MiB call + native prompt <=1 MiB + six <=1 MiB merge
 * heads (Agent messages.ts:436-477) + <=64 KiB saved result + <4.75 MiB
 * bounded indexed readiness/group-release/wake metadata (releaseGroups):
 * <13 MiB <16 MiB. Approval/deferred counts never multiply native reads.
 * At most 16 fixed-size references are reindexed per answer.
 * No tool payload is copied into coordination state, even for large inputs.
 */
export async function answerDeferredCall(
  ctx: MutationCtx,
  args: { assignmentId: Id<"assignments">; subject: string; toolCallId: string; text: string },
) {
  const row = await ctx.db.get("assignments", args.assignmentId);

  if (!row || row.subject !== args.subject) throw new ConvexError({ code: "FORBIDDEN" });

  if (!args.text.trim() || args.text.length > LIMITS.messageLength)
    throw new ConvexError({ code: "INVALID_MESSAGE" });

  if (!args.toolCallId || args.toolCallId.length > LIMITS.nativeCallIdLength)
    throw new ConvexError({ code: "TOOL_CALL_NOT_FOUND" });

  const receipt = await responseReceipt(ctx, "answer", row.threadId, args.toolCallId, args.text);

  if (receipt.messageId !== undefined) return { messageId: receipt.messageId, replayed: true };

  const pause = row.approvals;
  const key = await approvalKey(args.toolCallId);

  const index =
    pause?.requests.findIndex((request) => request.deferred && request.key === key) ?? -1;

  const request = pause?.requests[index];

  if (
    !pause ||
    !request ||
    !row.approvalBlocked ||
    row.cancelled ||
    pause.cleanupPending ||
    pause.epoch !== row.cancellationEpoch
  )
    throw new ConvexError({ code: "TOOL_CALL_NOT_FOUND" });

  const toolName = await deferredToolName(ctx, row, pause, request.messageId, args.toolCallId);

  const messageId = await saveToolResult(ctx, row, pause, request.messageId, {
    toolCallId: args.toolCallId,
    toolName,
    text: args.text,
  });

  await saveResponseReceipt(ctx, receipt, messageId);

  const remaining = pause.requests.filter((_, offset) => offset !== index);
  const approvals = remaining.length ? { ...pause, requests: remaining } : undefined;
  const blocked = remaining.some((entry) => !entry.resolved);

  await ctx.db.patch("assignments", row._id, { approvals, approvalBlocked: blocked });
  // Always retain the last saved result as the future prompt, including a
  // partial answer. A concurrent answer/respond serializes on this same row.
  await ctx.db.patch("inbox", pause.inboxId, { messageId });

  if (!blocked) await wake(ctx, { ...row, approvals, approvalBlocked: false });

  return { messageId, replayed: false };
}

type Pause = NonNullable<Doc<"assignments">["approvals"]>;

/** Read the exact recorded assistant message and return the tool name of the
 * still-open, host-executed call being answered. One exact <=1 MiB read. */
async function deferredToolName(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  pause: Pause,
  messageId: string,
  toolCallId: string,
) {
  const [message]: (MessageDoc | null)[] = await ctx.runQuery(
    pause.getMessages as FunctionHandle<"query">,
    { messageIds: [messageId] },
  );

  const content = message?.message?.content;

  const call =
    message?.threadId === row.threadId &&
    message.message?.role === "assistant" &&
    Array.isArray(content)
      ? content.find((part) => part.type === "tool-call" && part.toolCallId === toolCallId)
      : undefined;

  if (!call || call.type !== "tool-call" || call.providerExecuted)
    throw new ConvexError({ code: "TOOL_CALL_NOT_FOUND" });

  return call.toolName;
}

/** Agent 0.7.7 example/convex/chat/human.ts:135-148 uses exactly this
 * native tool-result. Our mutation also releases the existing inbox anchor.
 * Reuse that control slot: a child with a full ready-FIFO backlog must
 * still be answerable, and partial answers must never allocate more rows.
 * Returns the saved native message id. */
async function saveToolResult(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  pause: Pause,
  promptMessageId: string,
  result: { toolCallId: string; toolName: string; text: string },
) {
  const saved = (await ctx.runMutation(pause.addMessages as FunctionHandle<"mutation">, {
    threadId: row.threadId,
    agentName: row.agent,
    promptMessageId,
    failPendingSteps: false,
    messages: [
      {
        message: {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: result.toolCallId,
              toolName: result.toolName,
              output: { type: "text", value: result.text },
            },
          ],
        },
      },
    ],
  })) as { messages: MessageDoc[] };

  return saved.messages[0]._id;
}

/** Approval responses MUST go through the authorized respond endpoint. A
 * response saved directly through Agent is not seen by this runtime.
 * See `respondToApproval`.
 */
export const respond = mutation({
  args: {
    assignmentId: v.id("assignments"),
    subject: v.string(),
    approvalId: v.string(),
    approved: v.boolean(),
    reason: v.optional(v.string()),
    addMessages: v.string(),
  },
  returns: vResponseResult,
  handler: (ctx, args) => respondToApproval(ctx, args),
});

/** Save a deferred native result and release its continuation atomically.
 * See `answerDeferredCall` for the read budget. */
export const answer = mutation({
  args: {
    assignmentId: v.id("assignments"),
    subject: v.string(),
    toolCallId: v.string(),
    text: v.string(),
  },
  returns: vResponseResult,
  handler: (ctx, args) => answerDeferredCall(ctx, args),
});
