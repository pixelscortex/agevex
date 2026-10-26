/**
 * Provider request attachment, one-shot expiry and read-only lookup results.
 * These handlers serve the stable registrations in charges.ts and preserve
 * request-id, deadline and attempt fences. Only billing evidence is retried;
 * no paid provider operation is started or repeated here.
 */
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { lookupJob } from "../shared/contracts.js";
import { LIMITS, integer, text } from "../shared/limits.js";
import { find, resolved, replay, remember } from "./charge_records.js";
import { pool, actionHandle, validateJobs } from "./jobs.js";
import { change } from "./charge_updates.js";
/** Attach one immutable provider request, then admit lookup and its independent deadline. */
export async function attachCharge(ctx, args) {
    text(args.requestId, "REQUEST_ID");
    validateJobs(args.jobs);
    integer(args.lookupMs, LIMITS.maxLookupMs, "LOOKUP_WINDOW");
    if (!args.lookupMs)
        throw new Error("INVALID_LOOKUP_WINDOW");
    const row = await find(ctx, args.key);
    if (!row)
        throw new Error("CHARGE_NOT_FOUND");
    const previous = replay(row, args.operationKey);
    if (previous)
        return previous;
    if (row.providerRequestId) {
        if (row.providerRequestId !== args.requestId)
            throw new Error("REQUEST_ID_CONFLICT");
    }
    const next = await startLookup(ctx, row, args.requestId, args.lookupMs, args.jobs);
    return await remember(ctx, next, args.operationKey);
}
/** Shared admission for attach and the run sweep. The stored window is never reset. */
export async function startLookup(ctx, row, requestId, lookupMs, jobs) {
    if (row.lookupUntil)
        return row;
    if (resolved(row)) {
        await ctx.db.patch("charges", row._id, { providerRequestId: requestId });
        return { ...row, providerRequestId: requestId };
    }
    const until = jobs.lookup ? Date.now() + lookupMs : undefined;
    const patch = {
        providerRequestId: requestId,
        lookupUntil: until,
        lookupAttempt: until ? 0 : undefined,
        reconciliation: until ? "running" : "unavailable",
    };
    await ctx.db.patch("charges", row._id, patch);
    if (until && jobs.lookup) {
        await pool.enqueueAction(ctx, actionHandle(jobs.lookup), {
            key: row.key,
            provider: row.provider,
            requestId,
            until,
            attempt: 0,
            jobs,
        }, { retry: false });
        // A separate one-shot deadline survives a crashed lookup worker. It does
        // no provider work, and reads the exact recorded id rather than scanning.
        await ctx.scheduler.runAt(until, internal.charges.expire, { id: row._id });
    }
    return { ...row, ...patch };
}
/** Finish unresolved evidence while retaining the last estimate at its recorded one-shot deadline. */
export async function expireCharge(ctx, { id }) {
    const row = await ctx.db.get("charges", id);
    if (row?.lookupUntil && Date.now() >= row.lookupUntil && row.reconciliation !== "complete")
        await change(ctx, row, { reconciliation: "exhausted" }, { maxAttempts: LIMITS.maxAttempts });
}
/** Retain late evidence but fence duplicate empty callbacks before scheduling another lookup. */
export async function recordLookupResult(ctx, args) {
    validateJobs(args.jobs);
    integer(args.attempt, LIMITS.maxAttempts, "ATTEMPT");
    const row = await find(ctx, args.key);
    if (!row ||
        row.reconciliation === "complete" ||
        row.status === "settled" ||
        row.provider !== args.provider ||
        row.lookupUntil !== args.until ||
        row.providerRequestId !== args.requestId)
        return null;
    // A real response already in flight may arrive after expiry. Do not start
    // new provider work then, but retain that evidence rather than losing it.
    if (args.nanos !== undefined) {
        // Same rule as update: a real amount above the per-charge cap is kept
        // (and billed, source "lookup") as unknown/OVER_CAP, never discarded.
        integer(args.nanos, LIMITS.maxBilledNanos, "NANOS");
        const over = args.nanos > LIMITS.maxChargeNanos;
        if (args.credits !== undefined)
            integer(args.credits, LIMITS.maxQuantity, "CREDITS");
        await change(ctx, row, {
            status: over || row.reason === "THREAD_CAPACITY" ? "unknown" : "settled",
            source: "lookup",
            nanos: args.nanos,
            ...(args.credits === undefined ? {} : { credits: args.credits }),
            // THREAD_CAPACITY routes projections and must never change.
            ...(row.reason === "THREAD_CAPACITY" ? {} : over ? { reason: "OVER_CAP" } : {}),
        }, args.jobs);
    }
    else if (row.reconciliation !== "running" || args.attempt !== row.lookupAttempt) {
        return null;
    }
    else if (Date.now() >= args.until) {
        await change(ctx, row, { reconciliation: "exhausted" }, args.jobs);
    }
    else if (args.attempt + 1 < args.jobs.maxAttempts && args.jobs.lookup) {
        // Duplicate callbacks cannot admit another retry chain.
        await ctx.db.patch("charges", row._id, { lookupAttempt: args.attempt + 1 });
        const delay = Math.min(LIMITS.maxBackoffMs, LIMITS.backoffMs * LIMITS.backoffBase ** args.attempt);
        const { nanos: _nanos, credits: _credits, ...job } = args;
        await pool.enqueueAction(ctx, actionHandle(args.jobs.lookup), { ...job, attempt: args.attempt + 1 }, { retry: false, runAt: Math.min(Date.now() + delay, args.until) });
    }
    else {
        await ctx.db.patch("charges", row._id, {
            lookupAttempt: args.attempt + 1,
            reconciliation: "exhausted",
        });
    }
    return null;
}
