/** Capability/version fences for background work. A lease starts only at paid
 * dispatch. Titles belong to the accepted first message; summaries belong to
 * the current execution epoch. Native title checks and writes share a mutation. */
import { v } from "convex/values";
import type { FunctionHandle } from "convex/server";
import type { Doc } from "../_generated/dataModel.js";
import { mutation, query, internalMutation, type MutationCtx } from "../_generated/server.js";
import { internal } from "../_generated/api.js";
import { messageRef } from "../hooks/refs.js";
import { TEXT_LIMITS, storedSummary, textBoundary, textKind, validText } from "./values.js";
import { after, summaryWindow } from "./window.js";
import { queueText } from "./jobs.js";

const jobArgs = { assignmentId: v.id("assignments"), kind: textKind, key: v.string() };

type JobArgs = { kind: "title" | "summary"; key: string };

/** Foreground cancellation cannot invalidate the first accepted message's title. */
function liveJob(row: Doc<"assignments"> | null, args: JobArgs) {
  const job = row?.[args.kind === "title" ? "titleTask" : "summaryTask"];

  if (!row || job?.key !== args.key) return null;

  if (args.kind === "summary" && (row.cancelled || job.epoch !== row.cancellationEpoch))
    return null;

  return job;
}

/** Native Agent threads.ts:35-41 reads one exact thread, at most 1 MiB. This
 * remains below the 16 MiB transaction budget with the <=40 KiB assignment. */
async function hasNativeTitle(ctx: Pick<MutationCtx, "runQuery">, row: Doc<"assignments">) {
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
  refs: v.array(messageRef),
  previous: v.string(),
  through: v.optional(textBoundary),
});

/** Cheap preflight before task preparation; dispatch repeats it atomically. */
export const active = query({
  args: jobArgs,
  returns: v.boolean(),
  handler: async (ctx, args) =>
    liveJob(await ctx.db.get("assignments", args.assignmentId), args)?.status === "running",
});

/** Claim only preparation. Slow authorization or input reads cannot consume a
 * paid lease or turn a pre-dispatch cancellation into an unknown outcome. */
export const claim = mutation({
  args: jobArgs,
  returns: v.union(v.null(), snapshot),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    const job = liveJob(row, args);

    if (!row || job?.status !== "queued") return null;

    if (args.kind === "title" && (await hasNativeTitle(ctx, row))) return null;

    const window = args.kind === "summary" ? summaryWindow(row) : null;
    const field = args.kind === "title" ? "titleTask" : "summaryTask";

    await ctx.db.patch("assignments", row._id, { [field]: { ...job, status: "running" } });
    const run = await ctx.db.get("runs", job.runId);

    return {
      subject: row.subject,
      agent: row.agent,
      threadId: row.threadId,
      runId: job.runId,
      modelId: run?.models?.[row.agent],
      refs: (window?.refs ?? (job.titleRef ? [job.titleRef] : [])).map(
        ({ id, order, stepOrder, bytes }) => ({ id, order, stepOrder, bytes }),
      ),
      previous: window?.previous ?? "",
      through: window?.through,
    };
  },
});

/** Final admission immediately before the provider's doGenerate call. A worker
 * crash after this transaction is the first point where a paid outcome can be
 * unknown. Duplicate/stale workers cannot start a second dispatch. */
export const dispatch = mutation({
  args: jobArgs,
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    const job = liveJob(row, args);

    if (!row || job?.status !== "running" || job.dispatched) return false;

    if (args.kind === "title" && (await hasNativeTitle(ctx, row))) return false;

    const field = args.kind === "title" ? "titleTask" : "summaryTask";

    await ctx.db.patch("assignments", row._id, { [field]: { ...job, dispatched: true } });
    await ctx.scheduler.runAfter(TEXT_LIMITS.leaseMs, internal.text.state.expire, args);

    return true;
  },
});

/** Timeout detection never schedules paid work. Only dispatched jobs can have
 * an unknown paid outcome; preparing/queued jobs remain retryable. */
export const expire = internalMutation({
  args: jobArgs,
  returns: v.null(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    const field = args.kind === "title" ? "titleTask" : "summaryTask";
    const job = row?.[field];

    if (row && job?.key === args.key && job.status === "running" && job.dispatched)
      await ctx.db.patch("assignments", row._id, {
        [field]: { ...job, status: "unknown", again: undefined },
      });

    return null;
  },
});

/** A native app rename outside our endpoint also wins, atomically. */
async function commitTitle(ctx: MutationCtx, row: Doc<"assignments">, text: string) {
  const job = row.titleTask!;

  if (
    row.titleSource === "user" ||
    (row.titleVersion ?? 0) !== job.version ||
    (await hasNativeTitle(ctx, row))
  )
    return;

  await ctx.runMutation(
    row.textConfig!.updateThread as FunctionHandle<
      "mutation",
      { threadId: string; patch: { title: string } },
      unknown
    >,
    { threadId: row.threadId, patch: { title: text } },
  );

  await ctx.db.patch("assignments", row._id, {
    titleVersion: job.version + 1,
    titleSource: "auto",
  });
}

/** Known failures can advance at the next cadence; unknown jobs need an
 * explicit fresh request key. No failed/unknown job itself is ever replayed. */
export const commit = mutation({
  args: {
    ...jobArgs,
    status: v.union(v.literal("done"), v.literal("failed"), v.literal("unknown")),
    text: v.optional(v.string()),
    through: v.optional(textBoundary),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);
    const field = args.kind === "title" ? "titleTask" : "summaryTask";
    const job = row?.[field];

    if (!row || job?.key !== args.key || job.status !== "running") return false;

    // A cancelled execution cannot publish text, but its matching worker has
    // returned. Close the job as a known failure so expiry cannot turn that
    // discarded result into unknown and block every later cadence point.
    if (!liveJob(row, args)) {
      await ctx.db.patch("assignments", row._id, {
        [field]: { ...job, status: "failed", again: undefined },
      });

      return false;
    }

    const done =
      args.status === "done" &&
      job.dispatched &&
      args.text !== undefined &&
      validText(args.text, args.kind);

    const status = done
      ? ("done" as const)
      : args.status === "unknown" && job.dispatched
        ? ("unknown" as const)
        : ("failed" as const);

    const patch = { [field]: { ...job, status, again: undefined } };

    await ctx.db.patch("assignments", row._id, patch);

    if (done && args.kind === "title") await commitTitle(ctx, row, args.text!);

    if (
      done &&
      args.kind === "summary" &&
      args.through &&
      (!row.textSummary || after(args.through, row.textSummary.through))
    )
      await ctx.db.patch("assignments", row._id, {
        textSummary: { text: args.text!, through: args.through },
      });

    if (
      done &&
      job.again &&
      row.textCompleted &&
      args.through &&
      after(row.textCompleted, args.through)
    )
      await queueText(ctx, { ...row, ...patch } as typeof row, "summary", job.again);

    return !!done;
  },
});

/** Bounded display metadata; summaries never alter native conversation context. */
export const view = query({
  args: { assignmentId: v.id("assignments") },
  returns: v.object({
    version: v.number(),
    source: v.union(v.null(), v.literal("auto"), v.literal("user")),
    summary: v.union(v.null(), storedSummary),
  }),
  handler: async (ctx, args) => {
    const row = await ctx.db.get("assignments", args.assignmentId);

    if (!row) throw new Error("FORBIDDEN");

    return {
      version: row.titleVersion ?? 0,
      source: row.titleSource ?? null,
      summary: row.textSummary ?? null,
    };
  },
});
