import { v } from "convex/values";
import { mutation, query, internalMutation, type MutationCtx } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import { identity, failure, summary, usage } from "./schema.js";
import { manager } from "./workflows.js";
import { LIMITS, bounded, integer } from "../limits.js";

const fence = { artifactId: v.id("artifacts"), attempt: v.number(), claim: v.string() };
function validateFence(args: { attempt: number; claim: string }) {
  integer(args.attempt, LIMITS.maxAttempts, LIMITS.initialAttempt);
  bounded(args.claim);
}
function current(row: Doc<"artifacts"> | null, args: { attempt: number; claim: string }) {
  return row?.attempt === args.attempt && row.claim === args.claim;
}
/** Failed attempts keep their paid usage; a retry adds to it rather than replacing it. */
function addUsage(
  before: Doc<"artifacts">["usage"],
  next: Doc<"artifacts">["usage"],
): Doc<"artifacts">["usage"] {
  if (!next) return before;
  if (!before) return next;
  const sum = (x?: number, y?: number) =>
    x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
  const merged = {
    inputTokens: sum(before.inputTokens, next.inputTokens),
    outputTokens: sum(before.outputTokens, next.outputTokens),
    credits: sum(before.credits, next.credits),
  };
  return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
}
const retryable = new Set(["PROVIDER_UNAVAILABLE", "OBJECT_UNAVAILABLE", "CHECKSUM_FAILED"]);
/**
 * Start (or restart) the one Workflow for this exact attempt and claim. Only
 * ids cross the boundary. The lease does NOT start here: a job waiting in the
 * queue has done no paid work, so its deadline is `queueMs` (see admit) and the
 * running lease starts in `start`, at the moment the provider may be paid.
 */
async function dispatch(
  ctx: MutationCtx,
  artifactId: Id<"artifacts">,
  attempt: number,
  claim: string,
  args: { threadId: string; subject?: string; worker: string; onComplete?: string },
) {
  await manager.start(
    ctx,
    internal.workflows.extract,
    {
      artifactId,
      attempt,
      claim,
      threadId: args.threadId,
      ...(args.subject === undefined ? {} : { subject: args.subject }),
      worker: args.worker,
      version: LIMITS.workflowVersion,
    },
    {
      startAsync: true,
      onComplete: internal.workflows.done,
      context: {
        artifactId,
        attempt,
        claim,
        ...(args.onComplete ? { onComplete: args.onComplete } : {}),
      },
    },
  );
}
/**
 * Constant transaction budget at every configured ceiling: identity lookup <= 1
 * artifact (< 4 KiB), insert/patch <= 1 artifact (< 4 KiB), plus a single native
 * Workflow start (small id-only args). No document grows with file/payload
 * bytes, page count, or the number of prior extractions.
 *
 * Decision (spec 5.3: reuse | wait | run(attempt + 1)):
 * - no row: insert attempt 1 and run;
 * - pending within its queue deadline, or running within its lease: wait;
 * - pending past its queue deadline: no paid work can have happened (`start`
 *   moves it to running transactionally), so dispatch it again under a new
 *   claim, same attempt; the stale dispatch can no longer start;
 * - running past its lease: unknown, reused, never rerun (paid outcome unknown);
 * - failed with a retryable code and attempts left: attempt + 1, run. This is
 *   always an explicit caller admission, never automatic, and bounded by
 *   LIMITS.maxAttempts;
 * - anything else (ready, final failure, unknown, released): reuse.
 */
export const admit = mutation({
  args: {
    ...identity,
    worker: v.string(),
    threadId: v.string(),
    subject: v.optional(v.string()),
    onComplete: v.optional(v.string()),
  },
  handler: async (
    ctx,
    args,
  ): Promise<{ artifactId: Id<"artifacts">; action: "run" | "wait" | "reuse" }> => {
    bounded(args.fileId);
    bounded(args.backend);
    bounded(args.version);
    bounded(args.optionsHash, LIMITS.hashBytes);
    bounded(args.threadId);
    if (args.subject !== undefined) bounded(args.subject);
    bounded(args.worker, LIMITS.urlBytes);
    if (args.onComplete) bounded(args.onComplete, LIMITS.urlBytes);
    const dispatchArgs = {
      threadId: args.threadId,
      ...(args.subject === undefined ? {} : { subject: args.subject }),
      worker: args.worker,
      ...(args.onComplete ? { onComplete: args.onComplete } : {}),
    };
    const row = await ctx.db
      .query("artifacts")
      .withIndex("by_identity", (q) =>
        q
          .eq("fileId", args.fileId)
          .eq("backend", args.backend)
          .eq("version", args.version)
          .eq("optionsHash", args.optionsHash),
      )
      .unique();
    if (row) {
      const expired = row.leaseUntil <= Date.now();
      if (row.status === "pending" && expired) {
        const claim = crypto.randomUUID();
        await ctx.db.patch("artifacts", row._id, {
          claim,
          leaseUntil: Date.now() + LIMITS.queueMs,
        });
        await dispatch(ctx, row._id, row.attempt, claim, dispatchArgs);
        return { artifactId: row._id, action: "run" };
      }
      if (row.status === "running" && expired) {
        await ctx.db.patch("artifacts", row._id, { status: "unknown" });
        return { artifactId: row._id, action: "reuse" };
      }
      if (
        row.status === "failed" &&
        row.failure &&
        retryable.has(row.failure) &&
        row.attempt < LIMITS.maxAttempts
      ) {
        const claim = crypto.randomUUID();
        const attempt = row.attempt + 1;
        await ctx.db.patch("artifacts", row._id, {
          status: "pending",
          attempt,
          claim,
          leaseUntil: Date.now() + LIMITS.queueMs,
          failure: undefined,
        });
        await dispatch(ctx, row._id, attempt, claim, dispatchArgs);
        return { artifactId: row._id, action: "run" };
      }
      return {
        artifactId: row._id,
        action: row.status === "pending" || row.status === "running" ? "wait" : "reuse",
      };
    }
    const claim = crypto.randomUUID();
    const attempt = LIMITS.initialAttempt;
    const artifactId = await ctx.db.insert("artifacts", {
      fileId: args.fileId,
      backend: args.backend,
      version: args.version,
      optionsHash: args.optionsHash,
      status: "pending",
      attempt,
      claim,
      leaseUntil: Date.now() + LIMITS.queueMs,
    });
    await dispatch(ctx, artifactId, attempt, claim, dispatchArgs);
    return { artifactId, action: "run" };
  },
});
/**
 * Record a terminal failure for an identity that can never be dispatched (no
 * backend accepts the file). No workflow, no lease, no provider call: just the
 * receipt, so reads return the typed error and the identity is reused instead
 * of failing the caller. Budget: one indexed lookup and at most one insert,
 * both < 4 KiB.
 */
export const reject = mutation({
  args: { ...identity, failure },
  handler: async (ctx, args): Promise<Id<"artifacts">> => {
    bounded(args.fileId);
    bounded(args.backend);
    bounded(args.version);
    bounded(args.optionsHash, LIMITS.hashBytes);
    const row = await ctx.db
      .query("artifacts")
      .withIndex("by_identity", (q) =>
        q
          .eq("fileId", args.fileId)
          .eq("backend", args.backend)
          .eq("version", args.version)
          .eq("optionsHash", args.optionsHash),
      )
      .unique();
    if (row) return row._id;
    return ctx.db.insert("artifacts", {
      fileId: args.fileId,
      backend: args.backend,
      version: args.version,
      optionsHash: args.optionsHash,
      status: "failed",
      failure: args.failure,
      attempt: LIMITS.initialAttempt,
      claim: crypto.randomUUID(),
      leaseUntil: Date.now(),
    });
  },
});
export const get = query({
  args: { artifactId: v.id("artifacts") },
  handler: (ctx, args) => ctx.db.get("artifacts", args.artifactId),
});
export const lookup = query({
  args: identity,
  handler: (ctx, args) => {
    bounded(args.fileId);
    bounded(args.backend);
    bounded(args.version);
    bounded(args.optionsHash, LIMITS.hashBytes);
    return ctx.db
      .query("artifacts")
      .withIndex("by_identity", (q) =>
        q
          .eq("fileId", args.fileId)
          .eq("backend", args.backend)
          .eq("version", args.version)
          .eq("optionsHash", args.optionsHash),
      )
      .unique();
  },
});
/**
 * Claim the dispatch itself: even replay of a host action cannot repeat paid
 * work. The running lease starts here, not at admission: a job that waited in
 * the Workflow/Workpool queue has not spent anything and must not expire
 * before it begins. A stale dispatch (older claim) fails the fence.
 */
export const start = mutation({
  args: fence,
  handler: async (ctx, args) => {
    validateFence(args);
    const row = await ctx.db.get("artifacts", args.artifactId);
    if (!current(row, args) || row?.status !== "pending") return false;
    await ctx.db.patch("artifacts", row._id, {
      status: "running",
      leaseUntil: Date.now() + LIMITS.leaseMs,
    });
    // One-shot expiry check for this started attempt; it never reschedules.
    await ctx.scheduler.runAfter(LIMITS.leaseMs, internal.artifacts.expire, args);
    return true;
  },
});
export const complete = mutation({
  args: {
    ...fence,
    payloadStorageId: v.optional(v.string()),
    summary: v.optional(summary),
    failure: v.optional(failure),
    usage: v.optional(usage),
    unknown: v.optional(v.boolean()),
  },
  handler: async (ctx, args) => {
    validateFence(args);
    const row = await ctx.db.get("artifacts", args.artifactId);
    if (!row || !current(row, args)) return false;
    if (args.usage)
      for (const value of Object.values(args.usage))
        if (
          value !== undefined &&
          (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
        )
          throw new Error("INVALID_EXTRACT_ARGUMENT");
    const usage = addUsage(row.usage, args.usage);
    // Paid usage survives a purge/expiry, but content and status do not. This
    // is accounting for the original attempt, never permission to publish it.
    if (row.status === "released" || row.status === "unknown") {
      if (usage) await ctx.db.patch("artifacts", row._id, { usage });
      return false;
    }
    if (row.status !== "running") return false;
    if (args.unknown || row.leaseUntil <= Date.now()) {
      await ctx.db.patch("artifacts", row._id, {
        status: "unknown",
        ...(usage ? { usage } : {}),
      });
      return false;
    }
    if (args.failure) {
      if (args.summary || args.payloadStorageId) throw new Error("INVALID_EXTRACT_ARGUMENT");
      await ctx.db.patch("artifacts", row._id, {
        status: "failed",
        failure: args.failure,
        ...(usage ? { usage } : {}),
      });
    } else {
      if (!args.summary || !args.payloadStorageId) throw new Error("INVALID_EXTRACT_ARGUMENT");
      bounded(args.payloadStorageId);
      integer(args.summary.textBytes, LIMITS.node.payloadBytes);
      integer(args.summary.pages, LIMITS.totalPages);
      if (args.summary.preview) bounded(args.summary.preview, LIMITS.summaryBytes);
      if (args.summary.language) bounded(args.summary.language);
      await ctx.db.patch("artifacts", row._id, {
        status: "ready",
        summary: args.summary,
        payloadStorageId: args.payloadStorageId,
        ...(usage ? { usage } : {}),
      });
    }
    return true;
  },
});
/**
 * Host-only storage cleanup for one native file: tombstone every extraction of
 * `fileId` (the permanent no-repeat receipt stays) and return their payload
 * storage ids for the host to delete. Admin operation: the artifact is shared by
 * every thread that attached the same bytes, so this affects all of them.
 * Components cannot `paginate`, so the walk is a creation-time cursor over the
 * `by_file` index: `after` is the first unprocessed row's creation time
 * (inclusive, so ties cannot be skipped; released rows are no-ops).
 * Budget: at most LIMITS.purgeBatch (32) artifacts patched and 33 read per call,
 * each < 4 KiB: < 132 KiB read, < 128 KiB written, 33 and 32 documents.
 */
export const purge = mutation({
  args: { fileId: v.string(), after: v.number() },
  handler: async (ctx, args) => {
    bounded(args.fileId);
    const rows = await ctx.db
      .query("artifacts")
      .withIndex("by_file", (q) => q.eq("fileId", args.fileId).gte("_creationTime", args.after))
      .take(LIMITS.purgeBatch + 1);
    const storageIds: string[] = [];
    for (const row of rows.slice(0, LIMITS.purgeBatch)) {
      if (row.status === "released") continue;
      if (row.payloadStorageId) storageIds.push(row.payloadStorageId);
      await ctx.db.patch("artifacts", row._id, {
        status: "released",
        payloadStorageId: undefined,
        summary: undefined,
      });
    }
    return {
      storageIds,
      // Every row of the page, released or not: `purge` still has to clean the
      // RAG index records of artifacts tombstoned by an earlier call.
      artifactIds: rows.slice(0, LIMITS.purgeBatch).map((row) => row._id),
      next: rows.length > LIMITS.purgeBatch ? rows[LIMITS.purgeBatch]!._creationTime : null,
    };
  },
});
/**
 * Workflow completion. Only a started attempt can have an unknown paid outcome;
 * a queued row never began, so it stays pending and a later admission may
 * dispatch it again after its queue deadline.
 */
export const abandon = internalMutation({
  args: { artifactId: v.string(), attempt: v.number(), claim: v.string() },
  handler: async (ctx, args): Promise<boolean> => {
    validateFence(args);
    const id = ctx.db.normalizeId("artifacts", args.artifactId);
    const row = id ? await ctx.db.get("artifacts", id) : null;
    if (!row || !current(row, args)) return false;
    if (row.status === "running") await ctx.db.patch("artifacts", row._id, { status: "unknown" });
    // True: this dispatch's claim is the row's current claim.
    return true;
  },
});
export const expire = internalMutation({
  args: fence,
  handler: async (ctx, args) => {
    validateFence(args);
    const row = await ctx.db.get("artifacts", args.artifactId);
    if (row && current(row, args) && row.leaseUntil <= Date.now() && row.status === "running")
      await ctx.db.patch("artifacts", row._id, { status: "unknown" });
    return null;
  },
});
