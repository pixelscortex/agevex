/**
 * Lookup, the completed-effect row builder and purge arming for the
 * `receipts` table.
 *
 * `receipts` is one `(scope, key)` ledger shared by request acceptance
 * (`request:<subject>`, turns/send.ts), tool effects (receipts/effects.ts)
 * and approval/answer responses (turns/approvals.ts), plus attachment
 * attestations (files/attachments.ts). Effect rows expire after
 * `LIMITS.receiptRetentionMs`; `armPurge` starts the single purge chain
 * (`receipts.effects.purge`) that removes them in bounded batches.
 */
import type { WithoutSystemFields } from "convex/server";
import { internal } from "../_generated/api.js";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
import { LIMITS } from "../limits.js";

/** The effect receipt for `(scope, key)`, or null. Attachment rows share the
 * table but never the scope/key index range, so they are filtered out. */
export async function findReceipt(ctx: Pick<QueryCtx, "db">, scope: string, key: string) {
  const row = await ctx.db
    .query("receipts")
    .withIndex("by_scope_key", (q) => q.eq("scope", scope).eq("key", key))
    .unique();
  return row?.kind === "effect" ? row : null;
}

/** An effect that committed inside the caller's own transaction, so it enters
 * the ledger already `done` (no claim or lease): request acceptance and native
 * approval/answer saves. Callers bound `result` (<=64 KiB) and arm the purge. */
export function newDoneReceipt(fields: {
  scope: string;
  key: string;
  fingerprint: string;
  result: unknown;
}): WithoutSystemFields<Doc<"receipts">> {
  return {
    kind: "effect",
    scope: fields.scope,
    key: fields.key,
    fingerprint: fields.fingerprint,
    status: "done",
    result: fields.result,
    expiresAt: Date.now() + LIMITS.receiptRetentionMs,
  };
}

/** One purge chain per nonempty effect ledger, rather than one scheduled job
 * per key. Ownership attestations never arm or prolong this scheduled chain.
 * Call BEFORE inserting the first effect receipt: an existing effect row
 * means a chain is already scheduled. */
export async function armPurge(ctx: MutationCtx) {
  if (
    !(await ctx.db
      .query("receipts")
      .withIndex("by_expiry", (q) => q.eq("kind", "effect"))
      .first())
  )
    await ctx.scheduler.runAfter(LIMITS.purgeIntervalMs, internal.receipts.effects.purge, {});
}
