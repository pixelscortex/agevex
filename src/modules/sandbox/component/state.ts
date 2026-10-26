// Component runtime source; keep host dependencies and environment access outside this boundary.
import { v, getConvexSize } from "convex/values";
import type { FunctionHandle } from "convex/server";
import { mutation, query, type MutationCtx, type QueryCtx } from "./_generated/server.js";
import type { Doc } from "./_generated/dataModel.js";
import { HARD_LIMITS, LIMITS, bounded, integer } from "../shared/limits.js";

/** Unique indexed lookup; writers cap each row below sandboxRowBytes. */
async function sandbox(ctx: Pick<QueryCtx, "db">, scopeKey: string) {
  bounded(scopeKey, LIMITS.scopeKeyChars, "SCOPE");

  return ctx.db
    .query("sandboxes")
    .withIndex("by_scope", (q) => q.eq("scopeKey", scopeKey))
    .unique();
}

function checkSize(value: unknown, maximum: number) {
  if (getConvexSize(value as never) > maximum) throw new Error("SANDBOX_ROW_TOO_LARGE");
}

export const get = query({
  args: { scopeKey: v.string() },
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
  handler: async (ctx, args) => {
    bounded(args.provider, LIMITS.providerChars, "PROVIDER");
    integer(args.ttl, HARD_LIMITS.ttl, "TTL");
    const row = await sandbox(ctx, args.scopeKey);
    const now = Date.now();

    if (
      args.existingOnly &&
      (!row || !row.sandboxId || row.state === "deleted" || row.state === "deleting")
    )
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
        ttl: args.ttl,
        claim,
        lastUsedAt: now,
        leaseUntil,
        cleanupAt: Math.max(now + args.ttl, leaseUntil),
      });

      return { status: "claimed" as const, claim };
    }

    if (row) {
      if (row.provider !== args.provider) throw new Error("SANDBOX_PROVIDER_CONFLICT");

      // Only an in-flight delete blocks use: its outcome is not known yet.
      if (row.state === "deleting") throw new Error("SANDBOX_DELETING");

      if (!row.sandboxId) {
        if (row.leaseUntil <= now && row.state === "creating")
          await ctx.db.patch("sandboxes", row._id, { state: "unknown" });

        return {
          status:
            row.leaseUntil > now && row.state === "creating"
              ? ("running" as const)
              : ("unknown" as const),
        };
      }

      const leaseUntil = now + LIMITS.actionBudgetMs;

      await ctx.db.patch("sandboxes", row._id, {
        lastUsedAt: now,
        leaseUntil,
        ttl: args.ttl,
        cleanupAt: Math.max(now + args.ttl, leaseUntil),
      });

      return { status: "existing" as const, sandboxId: row.sandboxId, claim: row.claim };
    }

    const claim = crypto.randomUUID();
    const leaseUntil = now + LIMITS.actionBudgetMs;

    const fields = {
      ...args,
      state: "creating" as const,
      claim,
      lastUsedAt: now,
      leaseUntil,
      cleanupAt: Math.max(now + args.ttl, leaseUntil),
    };

    checkSize(fields, LIMITS.sandboxRowBytes);
    await ctx.db.insert("sandboxes", fields);

    return { status: "claimed" as const, claim };
  },
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

    if (!row || row.sandboxId) return false;

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
    state: v.union(
      v.literal("creating"),
      v.literal("ready"),
      v.literal("stopped"),
      v.literal("unknown"),
      v.literal("deleted"),
    ),
  },
  returns: v.boolean(),
  handler: async (ctx, args) => {
    bounded(args.claim, LIMITS.claimChars, "CLAIM");

    if (args.sandboxId !== undefined) bounded(args.sandboxId, LIMITS.identityChars, "ID");

    const row = await sandbox(ctx, args.scopeKey);

    if (!row || row.claim !== args.claim || row.state === "deleted") return false;

    if (row.state === "deleting" && args.state !== "deleted" && args.state !== "unknown")
      return false;

    if (row.sandboxId && args.sandboxId && row.sandboxId !== args.sandboxId) return false;

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

/** At most two tiny active-job probes, independent of retained terminal history. */
async function hasJobs(ctx: Pick<QueryCtx, "db">, scopeKey: string) {
  for (const state of ["starting", "running"] as const)
    if (
      await ctx.db
        .query("jobs")
        .withIndex("by_scope_state", (q) => q.eq("scopeKey", scopeKey).eq("state", state))
        .first()
    )
      return true;

  return false;
}

/** Host cleanup is explicitly invoked; this query does not arm any recurring timer. */
export const expired = query({
  args: { limit: v.number() },
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
  handler: async (ctx, args) => {
    const row = await sandbox(ctx, args.scopeKey);

    if (!row || row.state === "deleted" || row.state === "deleting") return null;

    if (
      args.expiredOnly &&
      (row.cleanupAt === undefined ||
        row.cleanupAt > Date.now() ||
        row.lastUsedAt + row.ttl > Date.now())
    )
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

/** Cancel only pending wakes: canceling an in-progress action cancels its descendants. */
async function cancelWake(ctx: MutationCtx, row: Pick<Doc<"jobs">, "wakeId">) {
  if (row.wakeId && (await ctx.db.system.get(row.wakeId))?.state.kind === "pending")
    await ctx.scheduler.cancel(row.wakeId);
}

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
  handler: async (ctx, args) => {
    const row = await sandbox(ctx, args.scopeKey);

    if (!row?.sandboxId || row.state !== "ready") throw new Error("SANDBOX_NOT_READY");

    for (const field of ["subject", "threadId", "runId"] as const)
      bounded(args[field], LIMITS.identityChars, field);

    bounded(args.pollHandle, LIMITS.handleChars, "HANDLE");
    integer(args.maximum, HARD_LIMITS.jobsPerSandbox, "JOBS");
    integer(args.jobTimeoutMs, HARD_LIMITS.jobTimeoutMs, "JOB_TIMEOUT");
    integer(args.pollMinMs, HARD_LIMITS.pollMinMs, "POLL_MIN");
    integer(args.pollMaxMs, HARD_LIMITS.pollMaxMs, "POLL_MAX");

    if (args.pollMinMs > args.pollMaxMs) throw new Error("SANDBOX_INVALID_POLL_RANGE");

    // At most 2 * 64 * 64 KiB =8 MiB read, <=128 docs, two index
    // queries; plus one 8 KiB sandbox and <=3 small scheduler records. Only
    // active jobs are read. At most one job and one sandbox are written.
    let active = 0;

    for (const state of ["starting", "running"] as const)
      active += (
        await ctx.db
          .query("jobs")
          .withIndex("by_scope_state", (q) => q.eq("scopeKey", args.scopeKey).eq("state", state))
          .take(args.maximum)
      ).length;

    if (active >= args.maximum) throw new Error("SANDBOX_JOB_LIMIT");

    const { maximum: _maximum, jobTimeoutMs, ...fields } = args;
    const now = Date.now();
    const leaseUntil = Math.min(now + LIMITS.actionBudgetMs, now + jobTimeoutMs);

    const job = {
      ...fields,
      providerJobId: crypto.randomUUID(),
      sandboxId: row.sandboxId,
      directory: `${LIMITS.backgroundRoot}/${crypto.randomUUID()}`,
      state: "starting" as const,
      deadline: now + jobTimeoutMs,
      delayMs: args.pollMinMs,
      claim: crypto.randomUUID(),
      leaseUntil,
    };

    checkSize(job, LIMITS.jobRowBytes);
    const jobId = await ctx.db.insert("jobs", job);

    const wakeId = await ctx.scheduler.runAt(
      leaseUntil,
      args.pollHandle as FunctionHandle<"mutation">,
      { jobId },
    );

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
  },
});

export const attachJob = mutation({
  args: { jobId: v.id("jobs"), claim: v.string(), providerJobId: v.string() },
  handler: async (ctx, args) => {
    bounded(args.claim, LIMITS.claimChars, "CLAIM");
    bounded(args.providerJobId, LIMITS.identityChars, "JOB_ID");
    const row = await ctx.db.get("jobs", args.jobId);

    if (!row || row.state !== "starting" || row.claim !== args.claim) return false;

    await cancelWake(ctx, row);

    const wakeId = await ctx.scheduler.runAt(
      Math.min(Date.now() + row.pollMinMs, row.deadline),
      row.pollHandle as FunctionHandle<"mutation">,
      { jobId: row._id },
    );

    await ctx.db.patch("jobs", row._id, {
      providerJobId: args.providerJobId,
      state: "running",
      leaseUntil: 0,
      wakeId,
    });

    return true;
  },
});

export const getJob = query({
  args: { jobId: v.id("jobs") },
  handler: (ctx, args) => ctx.db.get("jobs", args.jobId),
});

/** Terminal transition shared by settlement and the watchdog's direct finish. */
async function terminate(
  ctx: MutationCtx,
  row: Doc<"jobs">,
  result: {
    state: "done" | "failed" | "unknown";
    exitCode?: number;
    logTail?: string;
    code?: "SANDBOX_JOB_DEADLINE";
  },
) {
  await cancelWake(ctx, row);
  checkSize({ ...row, ...result }, LIMITS.jobRowBytes);
  await ctx.db.patch("jobs", row._id, { ...result, wakeId: undefined });
  const owner = await sandbox(ctx, row.scopeKey);

  if (
    owner &&
    owner.state !== "deleted" &&
    owner.state !== "deleting" &&
    !(await hasJobs(ctx, row.scopeKey))
  )
    await ctx.db.patch("sandboxes", owner._id, {
      cleanupAt: Math.max(owner.lastUsedAt + owner.ttl, owner.leaseUntil),
    });

  return {
    type: "sandbox.job.completed" as const,
    jobId: row._id,
    ...(row.providerJobId ? { providerJobId: row.providerJobId } : {}),
    scopeKey: row.scopeKey,
    subject: row.subject,
    threadId: row.threadId,
    runId: row.runId,
    ...result,
  };
}

/** Polls only read provider state, but a lease still fences overlapping watchdogs. */
export const claimPoll = mutation({
  args: { jobId: v.id("jobs") },
  handler: async (ctx, args) => {
    const row = await ctx.db.get("jobs", args.jobId);
    const now = Date.now();

    if (!row || !["starting", "running"].includes(row.state) || row.leaseUntil > now) return null;

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
    const leaseUntil =
      Math.max(Math.min(now + LIMITS.actionBudgetMs, row.deadline), now) +
      LIMITS.backgroundKillBudgetMs +
      LIMITS.backgroundLeaseMarginMs;

    // A hard action timeout still leaves one wake to report an unknown launch
    // or continue safe status polling; it never replays the command.
    const wakeId = await ctx.scheduler.runAt(
      leaseUntil,
      row.pollHandle as FunctionHandle<"mutation">,
      { jobId: row._id },
    );

    await ctx.db.patch("jobs", row._id, {
      claim,
      leaseUntil,
      wakeId,
      ...(now >= row.deadline ? { lateAttempts: late + 1 } : {}),
    });

    return { ...row, claim };
  },
});

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

    const wakeId = await ctx.scheduler.runAt(
      Math.min(Date.now() + delayMs, row.deadline),
      row.pollHandle as FunctionHandle<"mutation">,
      { jobId: row._id },
    );

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
