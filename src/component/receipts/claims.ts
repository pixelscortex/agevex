/**
 * The claim/lease protocol of effect receipts, used by ledger.ts (`begin`,
 * `complete`, `unknown`) on behalf of the client's `defineOnceTool`.
 *
 * `beginEffect` either replays a recorded outcome, reports a live claim, or
 * hands out a fresh fencing claim with a lease. `completeEffect` records the
 * outcome only for the current claim inside its lease. Paid work is never
 * retried automatically: an expired lease is an `unknown` outcome, and only
 * a repeat-safe tool may claim again. An optional assignment fence ties the
 * effect to the turn that started it. Table: `receipts`; reads `assignments`.
 */
import { getConvexSize, type Value } from "convex/values";
import type { MutationCtx } from "../_generated/server.js";
import type { Id } from "../_generated/dataModel.js";
import { LIMITS } from "../limits.js";
import { armPurge, findReceipt } from "./records.js";

/** A receipt only carries its fencing token and lease while running; every
 * transition out of running spreads this to drop them, and a late holder's
 * claim then no longer matches anything. */
export const unclaimed = { claim: undefined, leaseUntil: undefined } as const;

/** The optional turn fence on ledger calls: when an assignment is named, the
 * caller must still own its running turn at this token and epoch. */
export type TurnFence = {
  assignmentId?: Id<"assignments">;
  executionId?: string;
  cancellationEpoch?: number;
};

/** False when the call names an assignment whose turn it no longer owns. */
export async function fenceHolds(ctx: MutationCtx, fence: TurnFence) {
  if (!fence.assignmentId) return true;

  const row = await ctx.db.get("assignments", fence.assignmentId);
  return !!(
    row &&
    !row.cancelled &&
    row.turnStatus === "running" &&
    row.turnToken === fence.executionId &&
    row.cancellationEpoch === fence.cancellationEpoch
  );
}

/** Claim `(scope, key)` for one effect attempt, or report why not: a
 * recorded outcome to replay, a live claim, a fingerprint conflict, an
 * `unknown` outcome (never re-run unless `repeatSafe`), or a stale turn. */
export async function beginEffect(
  ctx: MutationCtx,
  args: TurnFence & {
    scope: string;
    key: string;
    fingerprint: string;
    repeatSafe?: boolean;
    leaseMs?: number;
  },
) {
  if (!(await fenceHolds(ctx, args))) return { status: "stale" as const };

  const row = await findReceipt(ctx, args.scope, args.key);
  if (row && row.fingerprint !== args.fingerprint)
    return { status: "conflict" as const, code: "KEY_CONFLICT" as const };
  if (row?.status === "done" || row?.status === "failed")
    return { status: row.status, result: row.result ?? null };
  if (row?.status === "running" && row.leaseUntil! > Date.now())
    return { status: "running" as const };
  if (row && !args.repeatSafe) {
    if (row.status === "running")
      await ctx.db.patch("receipts", row._id, { ...unclaimed, status: "unknown" });
    return { status: "unknown" as const };
  }

  const leaseMs = args.leaseMs ?? LIMITS.leaseMs;
  if (!Number.isFinite(leaseMs) || leaseMs <= 0) throw new Error("INVALID_LEASE");
  const claim = crypto.randomUUID();
  const fields = {
    status: "running" as const,
    claim,
    leaseUntil: Date.now() + leaseMs,
    expiresAt: Date.now() + Math.max(leaseMs, LIMITS.receiptRetentionMs),
  };
  if (row) await ctx.db.patch("receipts", row._id, fields);
  else {
    await armPurge(ctx);
    await ctx.db.insert("receipts", {
      kind: "effect",
      scope: args.scope,
      key: args.key,
      fingerprint: args.fingerprint,
      ...fields,
    });
  }
  return { status: "claimed" as const, claim, leaseUntil: fields.leaseUntil };
}

/** Record the outcome of the current claim. A stale claim is ignored; a
 * claim whose lease already expired becomes `unknown` instead. */
export async function completeEffect(
  ctx: MutationCtx,
  args: TurnFence & { scope: string; key: string; claim: string; failed?: boolean; result: Value },
) {
  if (!(await fenceHolds(ctx, args))) return null;

  const row = await findReceipt(ctx, args.scope, args.key);
  // Lease expiry is an unknown outcome even if a late action subsequently
  // answers. A repeat-safe reclaim rotates the claim, fencing the old action.
  if (!row || row.claim !== args.claim || row.status !== "running") return null;
  if (row.leaseUntil! <= Date.now()) {
    await ctx.db.patch("receipts", row._id, { ...unclaimed, status: "unknown" });
    return null;
  }

  if (getConvexSize(args.result) > LIMITS.receiptResultBytes) throw new Error("RESULT_TOO_LARGE");
  await ctx.db.patch("receipts", row._id, {
    ...unclaimed,
    status: args.failed ? "failed" : "done",
    result: args.result,
  });
  return null;
}
