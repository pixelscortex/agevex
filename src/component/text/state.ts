/** Capability/epoch/version fences for background work. Native title writes
 * occur inside the commit mutation, so readers never see split metadata. */
import { v } from "convex/values";
import type { FunctionHandle } from "convex/server";
import { mutation, query, internalMutation } from "../_generated/server.js";
import { internal } from "../_generated/api.js";
import { messageRef } from "../hooks/refs.js";
import { TEXT_LIMITS, storedSummary, textBoundary, textKind, validText } from "./values.js";
import { after, summaryWindow } from "./window.js";
import { queueText } from "./jobs.js";

const jobArgs = { assignmentId: v.id("assignments"), kind: textKind, key: v.string() };

export const snapshot = v.object({
  subject: v.string(),
  agent: v.string(),
  threadId: v.string(),
  runId: v.id("runs"),
  epoch: v.number(),
  modelId: v.optional(v.string()),
  refs: v.array(messageRef),
  previous: v.string(),
  complete: v.boolean(),
  through: v.optional(textBoundary),
});

/** Recheck the job capability immediately before receipt-backed paid admission,
 * after potentially asynchronous host policy and exact native message reads. */
export const active = query({
  args: jobArgs,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    const job = row?.[args.kind === "title" ? "titleTask" : "summaryTask"];

    return (
      !!row &&
      !row.cancelled &&
      job?.key === args.key &&
      job.status === "running" &&
      job.epoch === row.cancellationEpoch
    );
  },
});

/** One atomic claim, before auth/budget/model work. A crashed worker becomes
 * unknown after a finite lease; a duplicate cannot buy another generation. */
export const claim = mutation({
  args: jobArgs,
  returns: v.union(v.null(), snapshot),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    const field = args.kind === "title" ? "titleTask" : "summaryTask";
    const job = row?.[field];

    if (
      !row ||
      row.cancelled ||
      !job ||
      job.key !== args.key ||
      job.epoch !== row.cancellationEpoch ||
      job.status !== "queued"
    )
      return null;

    const window = args.kind === "summary" ? summaryWindow(row) : null;

    await ctx.db.patch("assignments", row._id, { [field]: { ...job, status: "running" } });
    await ctx.scheduler.runAfter(TEXT_LIMITS.leaseMs, internal.text.state.expire, args);
    const run = await ctx.db.get("runs", job.runId);

    return {
      subject: row.subject,
      agent: row.agent,
      threadId: row.threadId,
      runId: job.runId,
      epoch: job.epoch,
      modelId: run?.models?.[row.agent],
      refs: (window?.refs ?? (job.titleRef ? [job.titleRef] : [])).map(
        ({ id, order, stepOrder, bytes }) => ({ id, order, stepOrder, bytes }),
      ),
      previous: window?.previous ?? "",
      complete: window?.complete ?? false,
      through: window?.through,
    };
  },
});

/** Timeout detection never schedules paid work. Cancellation fences commits
 * even if an uncooperative provider completes after the host stopped waiting. */
export const expire = internalMutation({
  args: jobArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    const field = args.kind === "title" ? "titleTask" : "summaryTask";
    const job = row?.[field];

    if (row && job?.key === args.key && job.status === "running")
      await ctx.db.patch("assignments", row._id, {
        [field]: { ...job, status: "unknown", again: undefined },
      });

    return null;
  },
});

/** Generated text is a suggestion: a user rename or a newer epoch always wins.
 * Title bodies live only on the native thread, not in a duplicate core store. */
export const commit = mutation({
  args: {
    ...jobArgs,
    status: v.union(v.literal("done"), v.literal("failed"), v.literal("unknown")),
    text: v.optional(v.string()),
    through: v.optional(textBoundary),
    complete: v.optional(v.boolean()),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    const field = args.kind === "title" ? "titleTask" : "summaryTask";
    const job = row?.[field];

    if (
      !row ||
      row.cancelled ||
      job?.key !== args.key ||
      job.status !== "running" ||
      job.epoch !== row.cancellationEpoch
    )
      return false;

    const done =
      args.status === "done" && args.text !== undefined && validText(args.text, args.kind);

    const patch = {
      [field]: {
        ...job,
        status: done
          ? ("done" as const)
          : args.status === "unknown"
            ? ("unknown" as const)
            : ("failed" as const),
        again: undefined,
      },
    };

    await ctx.db.patch("assignments", row._id, patch);

    if (
      done &&
      args.kind === "title" &&
      row.titleSource !== "user" &&
      (row.titleVersion ?? 0) === job.version
    ) {
      const handle = row.textConfig!.updateThread as FunctionHandle<
        "mutation",
        { threadId: string; patch: { title: string } },
        unknown
      >;

      await ctx.runMutation(handle, { threadId: row.threadId, patch: { title: args.text! } });

      await ctx.db.patch("assignments", row._id, {
        titleVersion: job.version + 1,
        titleSource: "auto",
      });
    }

    if (
      done &&
      args.kind === "summary" &&
      args.through &&
      (!row.textSummary || after(args.through, row.textSummary.through))
    )
      await ctx.db.patch("assignments", row._id, {
        textSummary: {
          text: args.text!,
          through: args.through,
          complete: args.complete ?? false,
          epoch: job.epoch,
        },
      });

    if (
      done &&
      job.again &&
      row.textCompleted &&
      args.through &&
      after(row.textCompleted, args.through)
    )
      await queueText(ctx, { ...row, ...patch } as typeof row, "summary", job.again);

    return done;
  },
});

/** Bounded metadata projection, shared by host reads and compaction selection. */
export const view = query({
  args: { assignmentId: v.id("assignments") },
  returns: v.object({
    version: v.number(),
    source: v.union(v.null(), v.literal("auto"), v.literal("user")),
    summary: v.union(v.null(), storedSummary),
    refs: v.array(v.object({ ...messageRef.fields, sequence: v.number() })),
    epoch: v.number(),
    cancelled: v.boolean(),
  }),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);

    if (!row) throw new Error("FORBIDDEN");

    return {
      version: row.titleVersion ?? 0,
      source: row.titleSource ?? null,
      summary: row.textSummary ?? null,
      refs: row.contextMessages ?? [],
      epoch: row.cancellationEpoch,
      cancelled: row.cancelled,
    };
  },
});
