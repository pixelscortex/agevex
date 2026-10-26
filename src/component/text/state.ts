/** Receipt capabilities fence background text writes. Native title inspection
 * and updates share a mutation, so an app rename wins even during generation. */
import { v } from "convex/values";
import type { FunctionHandle } from "convex/server";
import type { Doc } from "../_generated/dataModel.js";
import { mutation, internalMutation, type MutationCtx } from "../_generated/server.js";
import { internal } from "../_generated/api.js";
import { LIMITS } from "../limits.js";
import { findReceipt } from "../receipts/records.js";
import { textScope, releaseSummary, type TextJob } from "./jobs.js";
import { TEXT_LIMITS, textKind, validText } from "./values.js";

export const jobArgs = { assignmentId: v.id("assignments"), kind: textKind, key: v.string() };
type JobArgs = { assignmentId: Doc<"assignments">["_id"]; kind: "title" | "summary"; key: string };

/** Summary writes belong to the accepting epoch; title belongs to the first
 * accepted message and deliberately survives foreground cancellation. */
async function liveJob(ctx: MutationCtx, args: JobArgs) {
  if (
    (args.kind === "title" && args.key !== "title") ||
    (args.kind === "summary" &&
      (!args.key.startsWith("summary:") ||
        args.key.length <= "summary:".length ||
        args.key.length > LIMITS.requestKeyLength + "summary:".length))
  )
    return null;

  const row = await ctx.db.get("assignments", args.assignmentId);
  const receipt = await findReceipt(ctx, textScope(args.assignmentId), args.key);
  const job = receipt?.result as TextJob | undefined;

  if (!row?.textConfig || receipt?.status !== "running" || !job) return null;

  if (args.kind === "summary" && (row.cancelled || job.epoch !== row.cancellationEpoch))
    return null;

  return { row, receipt, job };
}

/** Agent threads.getThread reads exactly one <=1 MiB native document. */
async function hasNativeTitle(ctx: MutationCtx, row: Doc<"assignments">) {
  const thread = await ctx.runQuery(
    row.textConfig!.getThread as FunctionHandle<
      "query",
      { threadId: string },
      { title?: string } | null
    >,
    { threadId: row.threadId },
  );

  return thread?.title !== undefined;
}

export const snapshot = v.object({
  subject: v.string(),
  agent: v.string(),
  threadId: v.string(),
  runId: v.id("runs"),
  modelId: v.optional(v.string()),
  messageId: v.optional(v.string()),
});

/** Preparation cannot be reclaimed by duplicate Workflow/action deliveries. */
export const claim = mutation({
  args: jobArgs,
  returns: v.union(v.null(), snapshot),
  handler: async (ctx, args) => {
    const live = await liveJob(ctx, args);

    if (!live || live.job.phase !== "queued") return null;

    const { row, receipt, job } = live;

    if (args.kind === "title" && (await hasNativeTitle(ctx, row))) {
      await ctx.db.patch("receipts", receipt._id, {
        status: "done",
        result: undefined,
      });

      return null;
    }

    await ctx.db.patch("receipts", receipt._id, { result: { ...job, phase: "preparing" } });
    const run = await ctx.db.get("runs", job.runId);

    return {
      subject: row.subject,
      agent: row.agent,
      threadId: row.threadId,
      runId: job.runId,
      modelId: run?.models?.[row.agent],
      messageId: job.messageId,
    };
  },
});

/** This is the last admission immediately before provider doGenerate. Only
 * dispatched work has a paid lease; expiry records unknown and never retries. */
export const dispatch = mutation({
  args: jobArgs,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const live = await liveJob(ctx, args);

    if (!live || live.job.phase !== "preparing") return false;

    const { row, receipt, job } = live;

    if (args.kind === "title" && (await hasNativeTitle(ctx, row))) {
      await ctx.db.patch("receipts", receipt._id, { status: "done", result: undefined });

      return false;
    }

    await ctx.db.patch("receipts", receipt._id, {
      result: { ...job, phase: "dispatched" },
      leaseUntil: Date.now() + TEXT_LIMITS.leaseMs,
    });

    await ctx.scheduler.runAfter(TEXT_LIMITS.leaseMs, internal.text.state.expire, args);

    return true;
  },
});

/** A crash closes the existing receipt; it cannot buy another provider call. */
export const expire = internalMutation({
  args: jobArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const receipt = await findReceipt(ctx, textScope(args.assignmentId), args.key);

    if (
      receipt?.status === "running" &&
      receipt.leaseUntil !== undefined &&
      receipt.leaseUntil <= Date.now()
    ) {
      await releaseSummary(ctx, args.assignmentId, args.key);

      await ctx.db.patch("receipts", receipt._id, {
        status: "unknown",
        leaseUntil: undefined,
        result: undefined,
      });
    }

    return null;
  },
});

/** Native updateThread supports both fields (Agent component/threads.ts:85-106).
 * Reading native title and writing it inside this transaction makes concurrent
 * user/app renames conflict and retry against the new title instead of overwrite. */
export const commit = mutation({
  args: {
    ...jobArgs,
    status: v.union(v.literal("done"), v.literal("failed"), v.literal("unknown")),
    text: v.optional(v.string()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const receipt = await findReceipt(ctx, textScope(args.assignmentId), args.key);

    if (receipt?.status !== "running") return false;

    const live = await liveJob(ctx, args);
    const job = receipt.result as TextJob | undefined;
    const paid = job?.phase === "dispatched";
    const expired = paid && receipt.leaseUntil! <= Date.now();

    const done = !!(
      live &&
      paid &&
      !expired &&
      args.status === "done" &&
      args.text !== undefined &&
      validText(args.text, args.kind)
    );

    const status =
      expired || (args.status === "unknown" && paid) ? "unknown" : done ? "done" : "failed";

    await releaseSummary(ctx, args.assignmentId, args.key);

    await ctx.db.patch("receipts", receipt._id, {
      status,
      leaseUntil: undefined,
      result: undefined,
    });

    if (!done || !live) return false;

    if (args.kind === "title" && (await hasNativeTitle(ctx, live.row))) return true;

    await ctx.runMutation(
      live.row.textConfig!.updateThread as FunctionHandle<
        "mutation",
        { threadId: string; patch: { title?: string; summary?: string } },
        unknown
      >,
      { threadId: live.row.threadId, patch: { [args.kind]: args.text! } },
    );

    return true;
  },
});
