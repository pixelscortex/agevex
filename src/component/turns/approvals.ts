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
import {
  canonicalJson,
  decisionValidator,
  assertJson,
  validateAnswer,
  type Decision,
  type JsonSchema,
} from "../../shared/decisions.js";
import { readPending } from "./decision-reads.js";
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
 * Edited host responses additionally read <=2*32 KiB assignments, <=2*16 KiB
 * exact proposals and <=2*64 KiB receipts; the <=33 KiB effective-input receipt
 * includes one bounded call id, input and hashes. Even overcounting these reads
 * and writes together keeps the response path below 13.75 MiB <16 MiB.
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
    decision: Decision;
    effectiveInput?: unknown;
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
    canonicalJson(args.decision),
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

  const annotation = await recordEffectiveInput(ctx, row, decision, args);

  const messageId = await saveResponses(
    ctx,
    { ...row, messageId: decision.messageId, addMessages: args.addMessages },
    [
      {
        approvalId: args.approvalId,
        approved: args.decision.kind === "approve",
        ...(args.decision.kind === "reject" && args.decision.reason !== undefined
          ? { reason: args.decision.reason }
          : {}),
        ...(annotation?.edited ? { reason: JSON.stringify({ agevexApproval: annotation }) } : {}),
        ...(decision.providerExecuted ? { providerExecuted: true as const } : {}),
      },
    ],
  );

  await saveResponseReceipt(ctx, receipt, messageId);

  const requests = approvals.requests.map((request, offset) =>
    offset === index
      ? {
          ...request,
          resolved: true as const,
          ...(args.effectiveInput !== undefined ? { effective: true } : {}),
        }
      : request,
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
  args: { assignmentId: Id<"assignments">; subject: string; toolCallId: string; value: unknown },
) {
  const row = await ctx.db.get("assignments", args.assignmentId);

  if (!row || row.subject !== args.subject) throw new ConvexError({ code: "FORBIDDEN" });

  assertJson(args.value);

  if (!args.toolCallId || args.toolCallId.length > LIMITS.nativeCallIdLength)
    throw new ConvexError({ code: "TOOL_CALL_NOT_FOUND" });

  const receipt = await responseReceipt(
    ctx,
    "answer",
    row.threadId,
    args.toolCallId,
    canonicalJson(args.value),
  );

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

  const call = await readPending(ctx, row, request);

  const schema =
    call.tool === "ask_user" && call.input && typeof call.input === "object"
      ? (call.input as { agevexAnswerSchema?: JsonSchema }).agevexAnswerSchema
      : undefined;

  validateAnswer(args.value, schema);
  const toolName = call.tool;

  const messageId = await saveToolResult(ctx, row, pause, request.messageId, {
    toolCallId: args.toolCallId,
    toolName,
    value: args.value,
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
  result: { toolCallId: string; toolName: string; value: unknown },
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
              output: { type: "json", value: result.value },
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
    decision: decisionValidator,
    effectiveInput: v.optional(v.any()),
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
    value: v.any(),
  },
  returns: vResponseResult,
  handler: (ctx, args) => answerDeferredCall(ctx, args),
});

/** Bind immutable input to the exact call before the native decision can wake it.
 * One <=16 KiB source plus <=64 KiB receipt. Original proposal is never rewritten.
 */
async function recordEffectiveInput(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  request: Pause["requests"][number],
  args: { decision: Decision; effectiveInput?: unknown },
) {
  if (args.decision.kind !== "approve") return;

  if (args.decision.edit && (request.providerExecuted || args.effectiveInput === undefined))
    throw new ConvexError({ code: "APPROVAL_NOT_EDITABLE" });

  if (args.effectiveInput === undefined) return;

  assertJson(args.effectiveInput);
  const call = await readPending(ctx, row, request);

  const annotation = {
    edited: !!args.decision.edit,
    toolCallId: call.toolCallId,
    input: args.effectiveInput,
    originalHash: await approvalKey(canonicalJson(call.input)),
    effectiveHash: await approvalKey(canonicalJson(args.effectiveInput)),
  };

  await armPurge(ctx);

  await ctx.db.insert(
    "receipts",
    newDoneReceipt({
      scope: "approved-input",
      key: await approvalKey(JSON.stringify([row.threadId, call.toolCallId])),
      fingerprint: annotation.effectiveHash,
      result: annotation,
    }),
  );

  return annotation;
}
