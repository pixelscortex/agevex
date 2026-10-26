/**
 * Artifact admission decisions and Workflow dispatch under an attempt/claim fence.
 * artifacts.ts keeps the registered API; it calls admitArtifact in the same transaction.
 * This module reads and writes only artifacts and starts one id-only Workflow.
 */
import { LIMITS, bounded } from "../shared/limits.js";
import { internal } from "./_generated/api.js";
import { manager } from "./workflows.js";
const retryable = new Set(["PROVIDER_UNAVAILABLE", "OBJECT_UNAVAILABLE", "CHECKSUM_FAILED"]);
/**
 * Start (or restart) the one Workflow for this exact attempt and claim. Only
 * ids cross the boundary. The lease does NOT start here: a job waiting in the
 * queue has done no paid work, so its deadline is `queueMs` (see admit) and the
 * running lease starts in `start`, at the moment the provider may be paid.
 */
async function dispatch(ctx, artifactId, attempt, claim, args) {
    await manager.start(ctx, internal.workflows.extract, {
        artifactId,
        attempt,
        claim,
        threadId: args.threadId,
        ...(args.subject === undefined ? {} : { subject: args.subject }),
        worker: args.worker,
        version: LIMITS.workflowVersion,
    }, {
        startAsync: true,
        onComplete: internal.workflows.done,
        // No callback handle here: callers' handles live on the row so that a
        // superseded dispatch cannot take them with it.
        context: { artifactId, attempt, claim },
    });
}
/**
 * Append the caller's handle (a repeat of a stored handle is a no-op) for
 * any admission that will be followed by a completion: run, wait and
 * re-admits alike. A full list drops the new handle and says so.
 */
function callbacks(onComplete, existing) {
    const stored = existing ?? [];
    if (!onComplete)
        return { list: stored, outcome: undefined };
    if (stored.includes(onComplete))
        return { list: stored, outcome: "stored" };
    if (stored.length >= LIMITS.callbacksPerArtifact)
        return { list: stored, outcome: "dropped" };
    return { list: [...stored, onComplete], outcome: "stored" };
}
/** Report callback admission without persisting undefined wire fields. */
function result(artifactId, action, outcome) {
    return { artifactId, action, ...(outcome ? { callback: outcome } : {}) };
}
/** Validate before the identity read; pending insertion precedes dispatch in this transaction. */
export async function admitArtifact(ctx, args) {
    bounded(args.fileId);
    bounded(args.backend);
    bounded(args.version);
    bounded(args.optionsHash, LIMITS.hashBytes);
    bounded(args.threadId);
    if (args.subject !== undefined)
        bounded(args.subject);
    bounded(args.worker, LIMITS.urlBytes);
    if (args.onComplete)
        bounded(args.onComplete, LIMITS.callbackBytes);
    const dispatchArgs = {
        threadId: args.threadId,
        ...(args.subject === undefined ? {} : { subject: args.subject }),
        worker: args.worker,
    };
    const row = await ctx.db
        .query("artifacts")
        .withIndex("by_identity", (q) => q
        .eq("fileId", args.fileId)
        .eq("backend", args.backend)
        .eq("version", args.version)
        .eq("optionsHash", args.optionsHash))
        .unique();
    if (row)
        return admitExisting(ctx, args, row, dispatchArgs);
    const claim = crypto.randomUUID();
    const attempt = LIMITS.initialAttempt;
    const artifactId = await ctx.db.insert("artifacts", newPendingArtifact(args, attempt, claim));
    await dispatch(ctx, artifactId, attempt, claim, dispatchArgs);
    return result(artifactId, "run", args.onComplete ? "stored" : undefined);
}
/** Handle live, expired and terminal receipts without ever repeating an unknown paid outcome. */
async function admitExisting(ctx, args, row, dispatchArgs) {
    const expired = row.leaseUntil <= Date.now();
    if (row.status === "pending" && expired) {
        const claim = crypto.randomUUID();
        const kept = callbacks(args.onComplete, row.callbacks);
        await ctx.db.patch("artifacts", row._id, {
            claim,
            leaseUntil: Date.now() + LIMITS.queueMs,
            callbacks: kept.list.length ? kept.list : undefined,
        });
        await dispatch(ctx, row._id, row.attempt, claim, dispatchArgs);
        return result(row._id, "run", kept.outcome);
    }
    if (row.status === "running" && expired) {
        await ctx.db.patch("artifacts", row._id, { status: "unknown" });
        return { artifactId: row._id, action: "reuse" };
    }
    if (row.status === "failed" &&
        row.failure &&
        retryable.has(row.failure) &&
        row.attempt < LIMITS.maxAttempts) {
        const claim = crypto.randomUUID();
        const attempt = row.attempt + 1;
        const kept = callbacks(args.onComplete, row.callbacks);
        await ctx.db.patch("artifacts", row._id, {
            status: "pending",
            attempt,
            claim,
            leaseUntil: Date.now() + LIMITS.queueMs,
            failure: undefined,
            callbacks: kept.list.length ? kept.list : undefined,
        });
        await dispatch(ctx, row._id, attempt, claim, dispatchArgs);
        return result(row._id, "run", kept.outcome);
    }
    if (row.status === "pending" || row.status === "running") {
        // Waiting on a live dispatch: the caller is notified when it completes.
        const kept = callbacks(args.onComplete, row.callbacks);
        if (kept.list.length !== (row.callbacks?.length ?? 0))
            await ctx.db.patch("artifacts", row._id, { callbacks: kept.list });
        return result(row._id, "wait", kept.outcome);
    }
    // Already terminal: no completion will follow, so nothing is stored.
    return { artifactId: row._id, action: "reuse" };
}
/** Build a small id-only receipt; no source bytes or provider response can enter the row. */
function newPendingArtifact(args, attempt, claim) {
    return {
        // Permanent identity: later admissions reuse this exact receipt.
        fileId: args.fileId,
        backend: args.backend,
        version: args.version,
        optionsHash: args.optionsHash,
        // Dispatch fence and queue deadline; the paid lease starts only in start.
        status: "pending",
        attempt,
        claim,
        leaseUntil: Date.now() + LIMITS.queueMs,
        // Bounded handles are drained once by the owning Workflow completion.
        ...(args.onComplete ? { callbacks: [args.onComplete] } : {}),
    };
}
/** Build a terminal unsupported receipt without dispatch, preserving identity and attempt bounds. */
export function newRejectedArtifact(args) {
    return {
        // Identity is permanent even though this receipt can never be dispatched.
        fileId: args.fileId,
        backend: args.backend,
        version: args.version,
        optionsHash: args.optionsHash,
        // A terminal no-provider outcome has no running lease or callback.
        status: "failed",
        failure: args.failure,
        attempt: LIMITS.initialAttempt,
        claim: crypto.randomUUID(),
        leaseUntil: Date.now(),
    };
}
