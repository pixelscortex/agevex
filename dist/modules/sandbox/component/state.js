/**
 * Stable registered API for sandbox lifecycle and background-job metadata.
 * Admission and shared transitions live in helper modules; API paths remain state.*.
 * All reads are bounded or exact-id lookups; claims fence stale lifecycle and poll actions.
 */
import { v } from "convex/values";
import { sandboxDocument, jobDocument, reservation, jobReservation, jobCompletion, } from "./returns.js";
import {} from "convex/server";
import { mutation, query } from "./_generated/server.js";
import { HARD_LIMITS, LIMITS, bounded, integer } from "../shared/limits.js";
import { sandbox, hasJobs, cancelWake, terminate } from "./state_helpers.js";
import { reserveSandbox, reserveBackgroundJob } from "./admission.js";
/** Read the unique bounded scope binding for host lifecycle decisions. */
export const get = query({
    args: { scopeKey: v.string() },
    returns: v.union(v.null(), sandboxDocument),
    handler: (ctx, args) => sandbox(ctx, args.scopeKey),
});
/** Admission is transactional: a lost create result cannot authorize another create. */
export const reserve = mutation({
    args: {
        scopeKey: v.string(),
        provider: v.string(),
        ttl: v.number(),
        // Export: never create, revive or wait; only an existing, live sandbox.
        existingOnly: v.optional(v.boolean()),
    },
    returns: reservation,
    handler: reserveSandbox,
});
/**
 * Drop a reservation whose create outcome was lost (no provider id, unknown or
 * its lease expired). Never touches a row that has a sandboxId, so it cannot
 * orphan a known paid resource. The host first looks the lost sandbox up at
 * the provider (Daytona: label agevexScope / userKey = this scopeKey).
 */
export const forget = mutation({
    args: { scopeKey: v.string() },
    returns: v.boolean(),
    handler: async (ctx, args) => {
        const row = await sandbox(ctx, args.scopeKey);
        if (!row || row.sandboxId)
            return false;
        if (row.state !== "unknown" && !(row.state === "creating" && row.leaseUntil <= Date.now()))
            return false;
        await ctx.db.delete("sandboxes", row._id);
        return true;
    },
});
/** Save identity before readiness; stale lifecycle actions cannot revive a deleted row. */
export const save = mutation({
    args: {
        scopeKey: v.string(),
        claim: v.string(),
        sandboxId: v.optional(v.string()),
        state: v.union(v.literal("creating"), v.literal("ready"), v.literal("stopped"), v.literal("unknown"), v.literal("deleted")),
    },
    returns: v.boolean(),
    handler: async (ctx, args) => {
        bounded(args.claim, LIMITS.claimChars, "CLAIM");
        if (args.sandboxId !== undefined)
            bounded(args.sandboxId, LIMITS.identityChars, "ID");
        const row = await sandbox(ctx, args.scopeKey);
        if (!row || row.claim !== args.claim || row.state === "deleted")
            return false;
        if (row.state === "deleting" && args.state !== "deleted" && args.state !== "unknown")
            return false;
        if (row.sandboxId && args.sandboxId && row.sandboxId !== args.sandboxId)
            return false;
        await ctx.db.patch("sandboxes", row._id, {
            state: args.state,
            ...(args.sandboxId ? { sandboxId: args.sandboxId } : {}),
            ...(args.state === "deleted" || (args.state === "unknown" && row.state === "deleting")
                ? { cleanupAt: undefined }
                : {}),
        });
        return true;
    },
});
/** Host cleanup is explicitly invoked; this query does not arm any recurring timer. */
export const expired = query({
    args: { limit: v.number() },
    returns: v.array(sandboxDocument),
    handler: async (ctx, args) => {
        integer(args.limit, HARD_LIMITS.cleanupBatch, "BATCH");
        // Hard maximum: 64 * 8 KiB =512 KiB, <=64 docs and one index query.
        // Undefined deadlines are excluded, so failed deletes are never retried.
        return ctx.db
            .query("sandboxes")
            .withIndex("by_cleanup", (q) => q.gte("cleanupAt", 0).lte("cleanupAt", Date.now()))
            .take(args.limit);
    },
});
/** Recheck expiry atomically with delete admission to close the idle/use race. */
export const claimDelete = mutation({
    args: { scopeKey: v.string(), expiredOnly: v.boolean() },
    returns: v.union(v.null(), v.object({ sandboxId: v.string(), claim: v.string() })),
    handler: async (ctx, args) => {
        const row = await sandbox(ctx, args.scopeKey);
        if (!row || row.state === "deleted" || row.state === "deleting")
            return null;
        if (args.expiredOnly &&
            (row.cleanupAt === undefined ||
                row.cleanupAt > Date.now() ||
                row.lastUsedAt + row.ttl > Date.now()))
            return null;
        if (!row.sandboxId) {
            // An abandoned create has no identity we can safely delete. Retain its
            // reservation for reconciliation, but remove it from the sweep index;
            // a full batch of unknown creates must not schedule itself forever.
            if (row.leaseUntil <= Date.now())
                await ctx.db.patch("sandboxes", row._id, { state: "unknown", cleanupAt: undefined });
            return null;
        }
        if (await hasJobs(ctx, args.scopeKey)) {
            // A live job protects its filesystem. Removing its idle deadline keeps
            // cleanup finite; job settlement rearms it in the same transaction.
            await ctx.db.patch("sandboxes", row._id, { cleanupAt: undefined });
            return null;
        }
        const claim = crypto.randomUUID();
        await ctx.db.patch("sandboxes", row._id, { claim, state: "deleting", cleanupAt: undefined });
        return { sandboxId: row.sandboxId, claim };
    },
});
/** Reserve one bounded active job and persist its launch watchdog atomically. */
export const reserveJob = mutation({
    args: {
        scopeKey: v.string(),
        subject: v.string(),
        threadId: v.string(),
        runId: v.string(),
        pollHandle: v.string(),
        pollMinMs: v.number(),
        pollMaxMs: v.number(),
        jobTimeoutMs: v.number(),
        maximum: v.number(),
    },
    returns: jobReservation,
    handler: reserveBackgroundJob,
});
/** Attach a launch acknowledgement only while its original claim still owns the job. */
export const attachJob = mutation({
    args: { jobId: v.id("jobs"), claim: v.string(), providerJobId: v.string() },
    returns: v.boolean(),
    handler: async (ctx, args) => {
        bounded(args.claim, LIMITS.claimChars, "CLAIM");
        bounded(args.providerJobId, LIMITS.identityChars, "JOB_ID");
        const row = await ctx.db.get("jobs", args.jobId);
        if (!row || row.state !== "starting" || row.claim !== args.claim)
            return false;
        await cancelWake(ctx, row);
        const wakeId = await ctx.scheduler.runAt(Math.min(Date.now() + row.pollMinMs, row.deadline), row.pollHandle, { jobId: row._id });
        await ctx.db.patch("jobs", row._id, {
            providerJobId: args.providerJobId,
            state: "running",
            leaseUntil: 0,
            wakeId,
        });
        return true;
    },
});
/** Read one job by exact id for polling and host reconciliation. */
export const getJob = query({
    args: { jobId: v.id("jobs") },
    returns: v.union(v.null(), jobDocument),
    handler: (ctx, args) => ctx.db.get("jobs", args.jobId),
});
/** Polls only read provider state, but a lease still fences overlapping watchdogs. */
export const claimPoll = mutation({
    args: { jobId: v.id("jobs") },
    returns: v.union(v.null(), jobDocument),
    handler: async (ctx, args) => {
        const row = await ctx.db.get("jobs", args.jobId);
        const now = Date.now();
        if (!row || !["starting", "running"].includes(row.state) || row.leaseUntil > now)
            return null;
        const late = row.lateAttempts ?? 0;
        if (now >= row.deadline && late >= LIMITS.lateAttemptsMax) {
            // Two attempts claimed at or after the deadline never settled (their
            // actions died or hung). Each ran the kill and the normal notify path;
            // a third claim would only repeat them. End the job here: unknown, never
            // retried, readable via job(). This is the only path (besides revoked
            // authority) that skips the host callback, and it bounds the chain.
            await terminate(ctx, row, { state: "unknown", code: "SANDBOX_JOB_DEADLINE" });
            return null;
        }
        await cancelWake(ctx, row);
        const claim = crypto.randomUUID();
        // The lease starts no earlier than now, so it is always in the future: a
        // deadline already behind us must not produce a lease (and wake) in the
        // past. It covers the action, the separate bounded kill, and the settle.
        const leaseUntil = Math.max(Math.min(now + LIMITS.actionBudgetMs, row.deadline), now) +
            LIMITS.backgroundKillBudgetMs +
            LIMITS.backgroundLeaseMarginMs;
        // A hard action timeout still leaves one wake to report an unknown launch
        // or continue safe status polling; it never replays the command.
        const wakeId = await ctx.scheduler.runAt(leaseUntil, row.pollHandle, { jobId: row._id });
        await ctx.db.patch("jobs", row._id, {
            claim,
            leaseUntil,
            wakeId,
            ...(now >= row.deadline ? { lateAttempts: late + 1 } : {}),
        });
        return { ...row, claim };
    },
});
/** Release the matching poll claim into bounded backoff without relaunching work. */
export const again = mutation({
    args: { jobId: v.id("jobs"), claim: v.string() },
    returns: v.null(),
    handler: async (ctx, args) => {
        bounded(args.claim, LIMITS.claimChars, "CLAIM");
        const row = await ctx.db.get("jobs", args.jobId);
        if (!row || !["starting", "running"].includes(row.state) || row.claim !== args.claim)
            return null;
        await cancelWake(ctx, row);
        const delayMs = Math.min(row.delayMs * LIMITS.backoffFactor, row.pollMaxMs);
        const wakeId = await ctx.scheduler.runAt(Math.min(Date.now() + delayMs, row.deadline), row.pollHandle, { jobId: row._id });
        await ctx.db.patch("jobs", row._id, { delayMs, leaseUntil: 0, wakeId });
        return null;
    },
});
/** Called inside the host settlement mutation so callback/event and state are atomic. */
export const finishJob = mutation({
    args: {
        jobId: v.id("jobs"),
        claim: v.string(),
        state: v.union(v.literal("done"), v.literal("failed"), v.literal("unknown")),
        exitCode: v.optional(v.number()),
        logTail: v.optional(v.string()),
        code: v.optional(v.literal("SANDBOX_JOB_DEADLINE")),
    },
    returns: v.union(v.null(), jobCompletion),
    handler: async (ctx, args) => {
        bounded(args.claim, LIMITS.claimChars, "CLAIM");
        const row = await ctx.db.get("jobs", args.jobId);
        if (!row || !["starting", "running"].includes(row.state) || row.claim !== args.claim)
            return null;
        if (args.exitCode !== undefined && !Number.isSafeInteger(args.exitCode))
            throw new Error("SANDBOX_INVALID_EXIT_CODE");
        if (args.logTail && args.logTail.length > HARD_LIMITS.outputChars)
            throw new Error("SANDBOX_OUTPUT_TOO_LARGE");
        const { jobId: _jobId, claim: _claim, ...result } = args;
        return terminate(ctx, row, result);
    },
});
