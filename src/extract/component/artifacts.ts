import { v } from "convex/values";
import { mutation, query, internalMutation } from "./_generated/server.js";
import type { Doc, Id } from "./_generated/dataModel.js";
import { internal } from "./_generated/api.js";
import { identity, failure, summary, usage } from "./schema.js";
import { manager } from "./workflows.js";
import { LIMITS, bounded, integer } from "../limits.js";

const fence = { artifactId: v.id("artifacts"), attempt: v.number(), claim: v.string() };
function validateFence(args: { attempt: number; claim: string }) {
  integer(args.attempt, LIMITS.initialAttempt, LIMITS.initialAttempt);
  bounded(args.claim);
}
function current(row: Doc<"artifacts"> | null, args: { attempt: number; claim: string }) {
  return row?.attempt === args.attempt && row.claim === args.claim;
}
/**
 * Constant transaction budget at every configured ceiling: identity lookup <= 1
 * artifact (< 4 KiB), insert/patch <= 1 artifact (< 4 KiB), plus a single native
 * Workflow start (small id-only args) and one lease timer. No document grows
 * with file/payload bytes, page count, or the number of prior extractions.
 * The same rules as core receipts apply here because this optional component
 * cannot mutate core's receipts and must own only the brief's artifacts table.
 */
export const admit = mutation({
  args: {
    ...identity,
    worker: v.string(),
    threadId: v.string(),
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
    bounded(args.worker, LIMITS.urlBytes);
    if (args.onComplete) bounded(args.onComplete, LIMITS.urlBytes);
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
      if ((row.status === "pending" || row.status === "running") && row.leaseUntil <= Date.now()) {
        await ctx.db.patch("artifacts", row._id, { status: "unknown" });
        return { artifactId: row._id, action: "reuse" };
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
      leaseUntil: Date.now() + LIMITS.leaseMs,
    });
    await manager.start(
      ctx,
      internal.workflows.extract,
      {
        artifactId,
        attempt,
        claim,
        threadId: args.threadId,
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
    await ctx.scheduler.runAfter(LIMITS.leaseMs, internal.artifacts.expire, {
      artifactId,
      attempt,
      claim,
    });
    return { artifactId, action: "run" };
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
/** Claim the dispatch itself: even replay of a host action cannot repeat paid work. */
export const start = mutation({
  args: fence,
  handler: async (ctx, args) => {
    validateFence(args);
    const row = await ctx.db.get("artifacts", args.artifactId);
    if (!current(row, args) || row?.status !== "pending") return false;
    if (row.leaseUntil <= Date.now()) {
      await ctx.db.patch("artifacts", row._id, { status: "unknown" });
      return false;
    }
    await ctx.db.patch("artifacts", row._id, { status: "running" });
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
    // Paid usage survives a release/expiry, but content and status do not. This
    // is accounting for the original attempt, never permission to publish it.
    if (row.status === "released" || row.status === "unknown") {
      if (args.usage) await ctx.db.patch("artifacts", row._id, { usage: args.usage });
      return false;
    }
    if (row.status !== "running") return false;
    if (args.unknown || row.leaseUntil <= Date.now()) {
      await ctx.db.patch("artifacts", row._id, {
        status: "unknown",
        ...(args.usage ? { usage: args.usage } : {}),
      });
      return false;
    }
    if (args.failure) {
      if (args.summary || args.payloadStorageId) throw new Error("INVALID_EXTRACT_ARGUMENT");
      await ctx.db.patch("artifacts", row._id, {
        status: "failed",
        failure: args.failure,
        ...(args.usage ? { usage: args.usage } : {}),
      });
    } else {
      if (!args.summary || !args.payloadStorageId) throw new Error("INVALID_EXTRACT_ARGUMENT");
      bounded(args.payloadStorageId);
      integer(args.summary.textBytes, LIMITS.payloadBytes);
      integer(args.summary.pages, LIMITS.totalPages);
      if (args.summary.preview) bounded(args.summary.preview, LIMITS.summaryBytes);
      if (args.summary.language) bounded(args.summary.language);
      await ctx.db.patch("artifacts", row._id, {
        status: "ready",
        summary: args.summary,
        payloadStorageId: args.payloadStorageId,
        ...(args.usage ? { usage: args.usage } : {}),
      });
    }
    return true;
  },
});
export const release = mutation({
  args: { artifactId: v.id("artifacts") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("artifacts", args.artifactId);
    if (!row || row.status === "released") return null;
    // Return just the storage id so the host deletes its own blob. The row is
    // retained as the permanent no-repeat receipt for this paid identity.
    await ctx.db.patch("artifacts", row._id, {
      status: "released",
      payloadStorageId: undefined,
      summary: undefined,
    });
    return row.payloadStorageId ?? null;
  },
});
export const abandon = internalMutation({
  args: { artifactId: v.string(), attempt: v.number(), claim: v.string() },
  handler: async (ctx, args) => {
    validateFence(args);
    const id = ctx.db.normalizeId("artifacts", args.artifactId);
    const row = id ? await ctx.db.get("artifacts", id) : null;
    if (row && current(row, args) && (row.status === "pending" || row.status === "running"))
      await ctx.db.patch("artifacts", row._id, { status: "unknown" });
    return null;
  },
});
export const expire = internalMutation({
  args: fence,
  handler: async (ctx, args) => {
    validateFence(args);
    const row = await ctx.db.get("artifacts", args.artifactId);
    if (
      row &&
      current(row, args) &&
      row.leaseUntil <= Date.now() &&
      (row.status === "pending" || row.status === "running")
    )
      await ctx.db.patch("artifacts", row._id, { status: "unknown" });
    return null;
  },
});
