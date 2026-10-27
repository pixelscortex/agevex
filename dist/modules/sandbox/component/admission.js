/**
 * Transactional admission and row builders for sandboxes and background jobs.
 * state.reserve and state.reserveJob call these handlers with their original validators.
 * Create claims and job reconciliation identities commit before the host performs paid work.
 */
import {} from "convex/server";
import {} from "./_generated/server.js";
import { HARD_LIMITS, LIMITS, bounded, integer } from "../shared/limits.js";
import { sandbox, checkSize } from "./state_helpers.js";
/** Admit a sandbox identity with the original transactional fence and write order. */
export async function reserveSandbox(ctx, args) {
    bounded(args.provider, LIMITS.providerChars, "PROVIDER");
    integer(args.ttl, HARD_LIMITS.ttl, "TTL");
    const row = await sandbox(ctx, args.scopeKey);
    const now = Date.now();
    if (args.existingOnly &&
        (!row || !row.sandboxId || row.state === "deleted" || row.state === "deleting"))
        throw new Error("SANDBOX_NOT_FOUND");
    if (row && row.state === "deleted") {
        // A deleted sandbox is gone for good, so the scope is simply free again.
        // A new claim fences every action of the old binding (save/finish all
        // compare it), and the stale sandboxId must not survive into the new one.
        const claim = crypto.randomUUID();
        const leaseUntil = now + LIMITS.actionBudgetMs;
        await ctx.db.patch("sandboxes", row._id, {
            provider: args.provider,
            sandboxId: undefined,
            state: "creating",
            claim,
            idleExpiresAt: now + args.ttl,
            leaseUntil,
            cleanupAt: Math.max(now + args.ttl, leaseUntil),
        });
        return { status: "claimed", claim };
    }
    if (row) {
        if (row.provider !== args.provider)
            throw new Error("SANDBOX_PROVIDER_CONFLICT");
        // Only an in-flight delete blocks use: its outcome is not known yet.
        if (row.state === "deleting")
            throw new Error("SANDBOX_DELETING");
        if (!row.sandboxId) {
            if (row.leaseUntil <= now && row.state === "creating")
                await ctx.db.patch("sandboxes", row._id, { state: "unknown" });
            return {
                status: row.leaseUntil > now && row.state === "creating"
                    ? "running"
                    : "unknown",
            };
        }
        const leaseUntil = now + LIMITS.actionBudgetMs;
        await ctx.db.patch("sandboxes", row._id, {
            idleExpiresAt: now + args.ttl,
            leaseUntil,
            cleanupAt: Math.max(now + args.ttl, leaseUntil),
        });
        return { status: "existing", sandboxId: row.sandboxId, claim: row.claim };
    }
    const claim = crypto.randomUUID();
    const leaseUntil = now + LIMITS.actionBudgetMs;
    const fields = newSandboxRow(args, claim, leaseUntil, now);
    checkSize(fields, LIMITS.sandboxRowBytes);
    await ctx.db.insert("sandboxes", fields);
    return { status: "claimed", claim };
}
/** Admit one background launch with the original transactional fence and write order. */
export async function reserveBackgroundJob(ctx, args) {
    const row = await sandbox(ctx, args.scopeKey);
    if (!row?.sandboxId || row.state !== "ready")
        throw new Error("SANDBOX_NOT_READY");
    for (const field of ["subject", "threadId", "runId"])
        bounded(args[field], LIMITS.identityChars, field);
    bounded(args.pollHandle, LIMITS.handleChars, "HANDLE");
    integer(args.maximum, HARD_LIMITS.jobsPerSandbox, "JOBS");
    integer(args.jobTimeoutMs, HARD_LIMITS.jobTimeoutMs, "JOB_TIMEOUT");
    integer(args.pollMinMs, HARD_LIMITS.pollMinMs, "POLL_MIN");
    integer(args.pollMaxMs, HARD_LIMITS.pollMaxMs, "POLL_MAX");
    if (args.pollMinMs > args.pollMaxMs)
        throw new Error("SANDBOX_INVALID_POLL_RANGE");
    // At most 2 * 64 * 64 KiB =8 MiB read, <=128 docs, two index
    // queries; plus one 8 KiB sandbox and <=3 small scheduler records. Only
    // active jobs are read. At most one job and one sandbox are written.
    let active = 0;
    for (const state of ["starting", "running"])
        active += (await ctx.db
            .query("jobs")
            .withIndex("by_scope_state", (q) => q.eq("scopeKey", args.scopeKey).eq("state", state))
            .take(args.maximum)).length;
    if (active >= args.maximum)
        throw new Error("SANDBOX_JOB_LIMIT");
    const { maximum: _maximum, jobTimeoutMs, ...fields } = args;
    const now = Date.now();
    const leaseUntil = Math.min(now + LIMITS.actionBudgetMs, now + jobTimeoutMs);
    const job = newBackgroundJob(fields, row.sandboxId, now, jobTimeoutMs, leaseUntil);
    checkSize(job, LIMITS.jobRowBytes);
    const jobId = await ctx.db.insert("jobs", job);
    const wakeId = await ctx.scheduler.runAt(leaseUntil, args.pollHandle, { jobId });
    await ctx.db.patch("jobs", jobId, { wakeId });
    // No TTL deletion can race the still-unacknowledged provider launch.
    await ctx.db.patch("sandboxes", row._id, { cleanupAt: undefined });
    return {
        jobId,
        claim: job.claim,
        providerJobId: job.providerJobId,
        sandboxId: job.sandboxId,
        directory: job.directory,
    };
}
/** Initial lifecycle row: binding facts plus a lease that protects the paid create. */
function newSandboxRow(args, claim, leaseUntil, now) {
    return {
        // Store only the trusted binding and the absolute idle deadline.
        scopeKey: args.scopeKey,
        provider: args.provider,
        // The claim and lease prevent a lost create from admitting a second VM.
        state: "creating",
        claim,
        idleExpiresAt: now + args.ttl,
        leaseUntil,
        cleanupAt: Math.max(now + args.ttl, leaseUntil),
    };
}
/** Persist the reconciliation identity and filesystem location before launching paid work. */
function newBackgroundJob(fields, sandboxId, now, jobTimeoutMs, leaseUntil) {
    return {
        // Trusted attribution and bounded polling settings belong to the job.
        ...fields,
        // These identities exist before launch, even if its acknowledgement is lost.
        providerJobId: crypto.randomUUID(),
        sandboxId,
        directory: `${LIMITS.backgroundRoot}/${crypto.randomUUID()}`,
        // Deadline, backoff and lease bound the watchdog without retrying paid work.
        state: "starting",
        deadline: now + jobTimeoutMs,
        delayMs: fields.pollMinMs,
        claim: crypto.randomUUID(),
        leaseUntil,
    };
}
