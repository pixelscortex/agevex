/**
 * Accepting a host send (`queue.accept`) and its request receipts
 * (`queue.lookupReceipt`).
 *
 * Acceptance runs in the same transaction as the host's native prompt save:
 * it creates the root assignment on the thread's first send, opens a new run
 * budget, queues the prompt as a ready inbox row, records a `done` request
 * receipt under `request:<subject>` and wakes the thread. A repeated request
 * key returns its original receipt as `duplicate`; a different payload under
 * the same key is a KEY_CONFLICT. Touches `assignments`, `runs`, `inbox` and
 * `receipts`.
 */
import { v, type ObjectType } from "convex/values";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import { limitsValidator } from "../limits.js";
import { modelOverrides, validModelOverrides } from "../models.js";
import { messageRef, recordRefs } from "../hooks/refs.js";
import { armPurge, findReceipt, newDoneReceipt } from "../receipts/records.js";
import { assignmentByThread, newRootAssignment } from "./assignments.js";
import { newRun } from "./runs.js";
import { wake } from "./wake.js";

export const acceptArgs = {
  subject: v.string(),
  agent: v.string(),
  threadId: v.string(),
  requestKey: v.string(),
  fingerprint: v.string(),
  promptMessageId: v.string(),
  savedMessage: v.optional(messageRef),
  trackContext: v.optional(v.boolean()),
  runTurn: v.string(),
  limits: limitsValidator,
  models: v.optional(modelOverrides),
};

/** The typed duplicate/conflict receipt for an already accepted request, or
 * null for a new one. Shares the `request:<subject>` ledger scope. */
export async function requestReceipt(
  ctx: Pick<QueryCtx, "db">,
  subject: string,
  requestKey: string,
  fingerprint: string,
) {
  const row = await findReceipt(ctx, `request:${subject}`, requestKey);
  if (!row) return null;
  if (row.fingerprint !== fingerprint)
    return { status: "rejected" as const, code: "KEY_CONFLICT" as const };

  // The stored result omits receiptId and status: both are properties of the
  // ledger row itself, so they are derived here rather than written twice.
  const stored = row.result as { assignmentId: string; threadId: string; position: number };
  return { ...stored, receiptId: row._id, status: "duplicate" as const };
}

/** Admit one host send; see the file header. Throws (rolling back the native
 * save) for a foreign thread, recovery_required or a full ready queue. */
export async function acceptSend(ctx: MutationCtx, args: ObjectType<typeof acceptArgs>) {
  if (args.models && !validModelOverrides(args.models)) throw new Error("INVALID_MODELS");
  const duplicate = await requestReceipt(ctx, args.subject, args.requestKey, args.fingerprint);
  if (duplicate) return duplicate;

  let row = await assignmentByThread(ctx, args.threadId);
  if (!row) {
    const id = await ctx.db.insert("assignments", newRootAssignment(args));
    row = (await ctx.db.get("assignments", id))!;
  }
  if (row.subject !== args.subject || row.agent !== args.agent) throw new Error("FORBIDDEN");
  if (args.trackContext && !row.contextMessages) {
    await ctx.db.patch("assignments", row._id, { contextMessages: [] });
    row = { ...row, contextMessages: [] };
  }
  if (row.turnStatus === "recovery_required") throw new Error("RECOVERY_REQUIRED");
  if (row.queuedMessages >= row.limits.queueLength) throw new Error("QUEUE_LIMIT");
  if (row.cancelled) {
    await ctx.db.patch("assignments", row._id, { cancelled: false });
    row = { ...row, cancelled: false };
  }

  // queuedMessages excludes the head reserved by wake until claim deletes
  // its inbox row. Position counts that still-present row too; otherwise two
  // successive accepted messages would both report position zero.
  const position = row.queuedMessages + (row.inboxId ? 1 : 0);
  const models = args.models ?? row.models;
  const runId = await ctx.db.insert("runs", newRun(models));
  await ctx.db.insert("inbox", {
    assignmentId: row._id,
    messageId: args.promptMessageId,
    sequence: row.nextSequence,
    kind: "user",
    runId,
  });
  await ctx.db.patch("assignments", row._id, {
    models,
    queuedMessages: row.queuedMessages + 1,
    nextSequence: row.nextSequence + 1,
  });
  if (args.savedMessage) await recordRefs(ctx, row, [args.savedMessage]);

  await armPurge(ctx);
  // Acceptance and the host's native prompt save share one transaction: no
  // external effect can outlive an abandoned claim, so request receipts enter
  // the same ledger already done rather than leasing an action-shaped claim.
  const receiptId = await ctx.db.insert(
    "receipts",
    newDoneReceipt({
      scope: `request:${args.subject}`,
      key: args.requestKey,
      fingerprint: args.fingerprint,
      result: { assignmentId: row._id, threadId: args.threadId, position },
    }),
  );

  await wake(ctx, { ...row, queuedMessages: row.queuedMessages + 1 });
  return {
    assignmentId: row._id,
    threadId: args.threadId,
    receiptId,
    status: "accepted" as const,
    position,
  };
}
