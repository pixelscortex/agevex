/** One non-retried background job per receipt key. Temporary metadata contains
 * only native identities; title and summary text belong to the Agent thread. */
import type { Doc, Id } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";
import { internal } from "../_generated/api.js";
import { laneManager } from "../workflows/lanes.js";
import { armPurge, findReceipt, newDoneReceipt } from "../receipts/records.js";
import { LIMITS } from "../limits.js";

export type TextJob = {
  runId: Id<"runs">;
  epoch: number;
  messageId?: string;
  phase: "queued" | "preparing" | "dispatched";
};

export const textScope = (assignmentId: Id<"assignments">) => `thread-text:${assignmentId}`;

/** The title caller runs only at first acceptance. Summary keys are explicit;
 * neither failure nor lease expiry ever schedules another paid attempt. */
export async function queueText(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  kind: "title" | "summary",
  runId: Id<"runs">,
  messageId?: string,
  requestKey = "title",
) {
  if (!row.textConfig?.[kind] || row.childRunId) return false;

  const key = kind === "title" ? "title" : `summary:${requestKey}`;
  const scope = textScope(row._id);

  if (await findReceipt(ctx, scope, key)) return false;

  await armPurge(ctx);

  if (kind === "summary") {
    const active = await findReceipt(ctx, `${scope}:active`, "summary");

    if (active) throw new Error("SUMMARY_BUSY");

    await ctx.db.insert(
      "receipts",
      newDoneReceipt({
        scope: `${scope}:active`,
        key: "summary",
        fingerprint: row._id,
        result: key,
      }),
    );
  }

  const receiptId = await ctx.db.insert("receipts", {
    kind: "effect",
    scope,
    key,
    fingerprint: row._id,
    status: "running",
    expiresAt: Date.now() + LIMITS.receiptRetentionMs,
    result: {
      runId,
      epoch: row.cancellationEpoch,
      phase: "queued",
      ...(messageId ? { messageId } : {}),
    },
  });

  try {
    await laneManager(true, row.limits).start(
      ctx,
      internal.text.worker.work,
      { assignmentId: row._id, kind, key, handle: row.textConfig.worker },
      {
        startAsync: true,
        context: { assignmentId: row._id, kind, key },
        onComplete: internal.text.worker.done,
      },
    );
  } catch {
    await releaseSummary(ctx, row._id, key);

    await ctx.db.patch("receipts", receiptId, {
      status: "failed",
      result: undefined,
    });
  }

  return true;
}

/** A matching key alone can release the per-thread summary admission slot.
 * Late cleanup from old work cannot release a newer request. */
export async function releaseSummary(
  ctx: MutationCtx,
  assignmentId: Id<"assignments">,
  key: string,
) {
  const active = await findReceipt(ctx, `${textScope(assignmentId)}:active`, "summary");

  if (active?.result === key) await ctx.db.delete("receipts", active._id);
}
