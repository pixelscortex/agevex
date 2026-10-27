/** One non-retried background job per receipt key. Temporary metadata contains
 * only native identities; title text belongs to the Agent thread. */
import type { Doc, Id } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";
import { internal } from "../_generated/api.js";
import { laneManager } from "../workflows/lanes.js";
import { armPurge, findReceipt } from "../receipts/records.js";
import { LIMITS } from "../limits.js";

export type TextJob = {
  runId: Id<"runs">;
  messageId?: string;
  phase: "queued" | "preparing" | "dispatched";
};

export const textScope = (assignmentId: Id<"assignments">) => `thread-text:${assignmentId}`;

/** The title caller runs only at first acceptance;
 * neither failure nor lease expiry ever schedules another paid attempt. */
export async function queueText(
  ctx: MutationCtx,
  row: Doc<"assignments">,
  runId: Id<"runs">,
  messageId?: string,
) {
  if (!row.textConfig || row.childRunId) return false;

  const key = "title";
  const scope = textScope(row._id);

  if (await findReceipt(ctx, scope, key)) return false;

  await armPurge(ctx);

  const receiptId = await ctx.db.insert("receipts", {
    kind: "effect",
    scope,
    key,
    fingerprint: row._id,
    status: "running",
    expiresAt: Date.now() + LIMITS.receiptRetentionMs,
    result: {
      runId,
      phase: "queued",
      ...(messageId ? { messageId } : {}),
    },
  });

  try {
    await laneManager(true, row.limits).start(
      ctx,
      internal.text.worker.work,
      { assignmentId: row._id, handle: row.textConfig.worker },
      {
        startAsync: true,
        context: { assignmentId: row._id },
        onComplete: internal.text.worker.done,
      },
    );
  } catch {
    await ctx.db.patch("receipts", receiptId, {
      status: "failed",
      result: undefined,
    });
  }

  return true;
}
