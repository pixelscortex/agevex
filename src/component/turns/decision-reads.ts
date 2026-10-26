// Exact-id pending-call reads and receipt lookup; never discover calls in history.
import type { MessageDoc } from "@convex-dev/agent";
import type { FunctionHandle } from "convex/server";
import { ConvexError, v } from "convex/values";
import { query, type QueryCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
import { approvalKey, keyString } from "../approvals.js";
import { findReceipt } from "../receipts/records.js";
import { DECISION_LIMITS, decisionBytes } from "../../shared/decisions.js";

export const pendingItem = v.object({
  id: v.string(),
  toolCallId: v.string(),
  threadId: v.string(),
  agent: v.string(),
  kind: v.union(v.literal("approval"), v.literal("ask")),
  tool: v.string(),
  input: v.any(),
  providerExecuted: v.boolean(),
});

/** One recorded reference reads one bounded native document, never a transcript page. */
export async function readPending(
  ctx: QueryCtx,
  row: Doc<"assignments">,
  request: NonNullable<Doc<"assignments">["approvals"]>["requests"][number],
) {
  const [doc] = (await ctx.runQuery(row.approvals!.getMessages as FunctionHandle<"query">, {
    messageIds: [request.messageId],
  })) as (MessageDoc | null)[];

  if (decisionBytes(doc) > DECISION_LIMITS.sourceBytes)
    throw new ConvexError({ code: "PENDING_SOURCE_TOO_LARGE" });

  const parts = doc?.message?.content;

  if (
    !doc ||
    doc.threadId !== row.threadId ||
    doc.message?.role !== "assistant" ||
    !Array.isArray(parts)
  )
    throw new Error("PENDING_CALL_NOT_FOUND");

  for (const call of parts) {
    if (
      call.type !== "tool-call" ||
      (await approvalKey(call.toolCallId)) !== keyString(request.toolCallKey)
    )
      continue;

    const approval = parts.find(
      (part) => part.type === "tool-approval-request" && part.toolCallId === call.toolCallId,
    );

    const item = {
      id: request.deferred
        ? call.toolCallId
        : approval?.type === "tool-approval-request"
          ? approval.approvalId
          : "",
      toolCallId: call.toolCallId,
      threadId: row.threadId,
      agent: row.agent,
      kind: request.deferred ? ("ask" as const) : ("approval" as const),
      tool: call.toolName,
      input: call.input,
      providerExecuted: !!call.providerExecuted,
    };

    if (decisionBytes(item) > DECISION_LIMITS.itemBytes) throw new Error("PENDING_ITEM_TOO_LARGE");

    return item;
  }

  throw new Error("PENDING_CALL_NOT_FOUND");
}

/** Resolve exactly one requested decision, or the already committed first receipt. */
export const detail = query({
  args: {
    assignmentId: v.id("assignments"),
    subject: v.string(),
    id: v.string(),
    deferred: v.boolean(),
  },
  returns: v.union(pendingItem, v.null()),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);

    if (!row || row.subject !== args.subject) throw new Error("FORBIDDEN");

    const key = await approvalKey(args.id);

    const receipt = await findReceipt(
      ctx,
      args.deferred ? "answer" : "respond",
      await approvalKey(JSON.stringify([row.threadId, args.id])),
    );

    if (receipt) return null;

    const request = row.approvals?.requests.find(
      (r) => r.key === key && !!r.deferred === args.deferred,
    );

    if (!request) throw new Error(args.deferred ? "TOOL_CALL_NOT_FOUND" : "APPROVAL_NOT_FOUND");

    return readPending(ctx, row, request);
  },
});

/** Root plus bounded live children. <=59*32 KiB metadata + 256*16 KiB native
 * sources + <=58*4 KiB child refs <6.1 MiB; output <=4 MiB. Reject a seventeenth
 * paused assignment BEFORE reading native bodies. Oversized direct native saves
 * fail on their first exact detail read, so cannot multiply a 1 MiB document.
 */
export const pending = query({
  args: {
    assignmentId: v.id("assignments"),
    subject: v.string(),
    rootRunId: v.optional(v.string()),
  },
  returns: v.array(pendingItem),
  handler: async (ctx, args) => {
    const root = await ctx.db.get("assignments", args.assignmentId);

    if (!root || root.subject !== args.subject || root.rootAssignmentId)
      throw new Error("FORBIDDEN");

    const runId = args.rootRunId ?? root.runId;

    if (!runId) return [];

    if (runId !== root.runId) throw new Error("RUN_NOT_FOUND");

    const run = await ctx.db.get("runs", root.runId!);

    if (!run) throw new Error("RUN_NOT_FOUND");

    const children = await ctx.db
      .query("subagentRuns")
      .withIndex("by_group", (q) => q.eq("parentRunId", root.runId!))
      .take(root.limits.runLaunches + root.limits.sideRunsPerRun);

    const rows = [root];

    for (const child of children) {
      if (!child.childAssignmentId || child.status === "completed" || child.status === "failed")
        continue;

      const row = await ctx.db.get("assignments", child.childAssignmentId);

      if (
        row &&
        row.subject === args.subject &&
        row.rootAssignmentId === root._id &&
        row.runId === runId
      )
        rows.push(row);
    }

    const paused = rows.filter(
      (r) => r.approvalBlocked && !r.cancelled && !r.approvals?.cleanupPending,
    );

    if (paused.length > DECISION_LIMITS.assignments) throw new Error("PENDING_LIMIT");

    const result = [];

    for (const row of paused)
      for (const request of row.approvals!.requests) {
        if (!request.resolved) result.push(await readPending(ctx, row, request));
      }

    if (decisionBytes(result) > DECISION_LIMITS.outputBytes)
      throw new Error("PENDING_OUTPUT_TOO_LARGE");

    return result;
  },
});

/** Edited input is retrieved only for the exact recorded call, within its assignment. */
export const effective = query({
  args: { assignmentId: v.id("assignments"), toolCallId: v.string() },
  returns: v.any(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    const key = await approvalKey(args.toolCallId);

    const request = row?.approvals?.requests.find(
      (r) => r.resolved && keyString(r.toolCallKey) === key,
    );

    if (!row || !request) return null;

    const receipt = await findReceipt(
      ctx,
      "approved-input",
      await approvalKey(JSON.stringify([row.threadId, args.toolCallId])),
    );

    if (request.effective && !receipt) throw new Error("APPROVED_INPUT_GONE");

    return receipt?.result ?? null;
  },
});
