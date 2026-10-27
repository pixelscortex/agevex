/**
 * Indexed sandbox lookups, job probes and shared terminal transitions.
 * Called by registered state handlers and admission helpers within their transaction.
 * Pending wakes are canceled safely; the last terminal job rearms sandbox TTL cleanup.
 */
import { getConvexSize } from "convex/values";
import { type MutationCtx, type QueryCtx } from "./_generated/server.js";
import { type Doc } from "./_generated/dataModel.js";
import { LIMITS, bounded } from "../shared/limits.js";

/** Unique indexed lookup; writers cap each row below sandboxRowBytes. */
export async function sandbox(ctx: Pick<QueryCtx, "db">, scopeKey: string) {
  bounded(scopeKey, LIMITS.scopeKeyChars, "SCOPE");

  return ctx.db
    .query("sandboxes")
    .withIndex("by_scope", (q) => q.eq("scopeKey", scopeKey))
    .unique();
}

/** Reject oversized metadata before inserting or terminating a row. */
export function checkSize(value: unknown, maximum: number) {
  if (getConvexSize(value as never) > maximum) throw new Error("SANDBOX_ROW_TOO_LARGE");
}

/** At most two tiny active-job probes, independent of retained terminal history. */
export async function hasJobs(ctx: Pick<QueryCtx, "db">, scopeKey: string) {
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

/** Cancel only pending wakes: canceling an in-progress action cancels its descendants. */
export async function cancelWake(ctx: MutationCtx, row: Pick<Doc<"jobs">, "wakeId">) {
  if (row.wakeId && (await ctx.db.system.get(row.wakeId))?.state.kind === "pending")
    await ctx.scheduler.cancel(row.wakeId);
}

/** Terminal transition shared by settlement and the watchdog's direct finish. */
export async function terminate(
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
      cleanupAt: Math.max(owner.idleExpiresAt, owner.leaseUntil),
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
