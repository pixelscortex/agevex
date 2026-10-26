/**
 * Registered artifact API for admission, fencing, completion, expiry, and purge.
 * Host clients call these functions; admission decisions live in artifactAdmission.ts.
 * Only bounded artifact receipts are stored here; payload bytes live in host storage.
 */
import { v } from "convex/values";
import { LIMITS, bounded, integer } from "../shared/limits.js";
import { internal } from "./_generated/api.js";
import { internalMutation, mutation, query } from "./_generated/server.js";
import { admitArtifact, newRejectedArtifact } from "./artifactAdmission.js";
import { failure, identity, summary, usage } from "./schema.js";
const fence = { artifactId: v.id("artifacts"), attempt: v.number(), claim: v.string() };
/** Validate an attempt and claim before any fenced artifact read or write. */
function validateFence(args) {
    integer(args.attempt, LIMITS.maxAttempts, LIMITS.initialAttempt);
    bounded(args.claim);
}
/** Match both attempt and claim so stale dispatches cannot publish or drain callbacks. */
function current(row, args) {
    return row?.attempt === args.attempt && row.claim === args.claim;
}
/** Failed attempts keep their paid usage; a retry adds to it rather than replacing it. */
function addUsage(before, next) {
    if (!next)
        return before;
    if (!before)
        return next;
    const sum = (x, y) => x === undefined && y === undefined ? undefined : (x ?? 0) + (y ?? 0);
    const merged = {
        inputTokens: sum(before.inputTokens, next.inputTokens),
        outputTokens: sum(before.outputTokens, next.outputTokens),
        credits: sum(before.credits, next.credits),
    };
    return Object.fromEntries(Object.entries(merged).filter(([, value]) => value !== undefined));
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
    handler: admitArtifact,
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
    handler: async (ctx, args) => {
        bounded(args.fileId);
        bounded(args.backend);
        bounded(args.version);
        bounded(args.optionsHash, LIMITS.hashBytes);
        const row = await ctx.db
            .query("artifacts")
            .withIndex("by_identity", (q) => q
            .eq("fileId", args.fileId)
            .eq("backend", args.backend)
            .eq("version", args.version)
            .eq("optionsHash", args.optionsHash))
            .unique();
        if (row)
            return row._id;
        return ctx.db.insert("artifacts", newRejectedArtifact(args));
    },
});
/** Read one exact artifact for authorized host wrappers; no transcript lookup is needed. */
export const get = query({
    args: { artifactId: v.id("artifacts") },
    handler: (ctx, args) => ctx.db.get("artifacts", args.artifactId),
});
/** Look up one extraction identity through its unique bounded index. */
export const lookup = query({
    args: identity,
    handler: (ctx, args) => {
        bounded(args.fileId);
        bounded(args.backend);
        bounded(args.version);
        bounded(args.optionsHash, LIMITS.hashBytes);
        return ctx.db
            .query("artifacts")
            .withIndex("by_identity", (q) => q
            .eq("fileId", args.fileId)
            .eq("backend", args.backend)
            .eq("version", args.version)
            .eq("optionsHash", args.optionsHash))
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
        if (!current(row, args) || row?.status !== "pending")
            return false;
        await ctx.db.patch("artifacts", row._id, {
            status: "running",
            leaseUntil: Date.now() + LIMITS.leaseMs,
        });
        // One-shot expiry check for this started attempt; it never reschedules.
        await ctx.scheduler.runAfter(LIMITS.leaseMs, internal.artifacts.expire, args);
        return true;
    },
});
/** Publish only the active running claim while retaining paid usage after expiry or purge. */
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
        if (!row || !current(row, args))
            return false;
        if (args.usage)
            for (const value of Object.values(args.usage))
                if (value !== undefined &&
                    (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER))
                    throw new Error("INVALID_EXTRACT_ARGUMENT");
        const usage = addUsage(row.usage, args.usage);
        // Paid usage survives a purge/expiry, but content and status do not. This
        // is accounting for the original attempt, never permission to publish it.
        if (row.status === "released" || row.status === "unknown") {
            if (usage)
                await ctx.db.patch("artifacts", row._id, { usage });
            return false;
        }
        if (row.status !== "running")
            return false;
        if (args.unknown || row.leaseUntil <= Date.now()) {
            await ctx.db.patch("artifacts", row._id, {
                status: "unknown",
                ...(usage ? { usage } : {}),
            });
            return false;
        }
        if (args.failure) {
            if (args.summary || args.payloadStorageId)
                throw new Error("INVALID_EXTRACT_ARGUMENT");
            await ctx.db.patch("artifacts", row._id, {
                status: "failed",
                failure: args.failure,
                ...(usage ? { usage } : {}),
            });
        }
        else {
            if (!args.summary || !args.payloadStorageId)
                throw new Error("INVALID_EXTRACT_ARGUMENT");
            bounded(args.payloadStorageId);
            integer(args.summary.textBytes, LIMITS.node.payloadBytes);
            integer(args.summary.pages, LIMITS.totalPages);
            if (args.summary.preview)
                bounded(args.summary.preview, LIMITS.summaryBytes);
            if (args.summary.language)
                bounded(args.summary.language);
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
        const storageIds = [];
        for (const row of rows.slice(0, LIMITS.purgeBatch)) {
            if (row.status === "released")
                continue;
            if (row.payloadStorageId)
                storageIds.push(row.payloadStorageId);
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
            next: rows.length > LIMITS.purgeBatch ? rows[LIMITS.purgeBatch]._creationTime : null,
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
    handler: async (ctx, args) => {
        validateFence(args);
        const id = ctx.db.normalizeId("artifacts", args.artifactId);
        const row = id ? await ctx.db.get("artifacts", id) : null;
        if (!row || !current(row, args))
            return { owned: false, callbacks: [] };
        // The owning dispatch takes every stored handle exactly once, atomically
        // clearing the list; a stale dispatch takes none and clears nothing.
        await ctx.db.patch("artifacts", row._id, {
            ...(row.status === "running" ? { status: "unknown" } : {}),
            // The owner ended without `start` (still queued): end its queue deadline
            // now. Otherwise a caller admitted after this point would see a live
            // `pending` row, get `wait`, store a callback and never be served; with the
            // deadline over, the next admission re-dispatches and fires its callback.
            ...(row.status === "pending" ? { leaseUntil: Date.now() } : {}),
            callbacks: undefined,
        });
        return { owned: true, callbacks: row.callbacks ?? [] };
    },
});
/** Mark only the owning expired running attempt unknown; never dispatch more paid work. */
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
