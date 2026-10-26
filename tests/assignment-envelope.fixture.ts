/** Shared adversarial assignment envelopes, measured as persisted Convex values. */
import { getConvexSize } from "convex/values";
import type { Doc } from "../src/component/_generated/dataModel.js";
import type { MutationCtx } from "../src/component/_generated/server.js";
import { HOST_LIMITS, LIMITS } from "../src/component/limits.js";

export function fullReport(resumeInboxId: Doc<"inbox">["_id"]) {
  return {
    promptMessageId: "p".repeat(LIMITS.messageIdBytes),
    messageIds: Array.from({ length: HOST_LIMITS.slicesPerTurn.max }, (_, i) =>
      String(i).padStart(LIMITS.messageIdBytes, "m"),
    ),
    maxMessages: HOST_LIMITS.slicesPerTurn.max,
    resumeInboxId,
  };
}

/** Only this fixture pads opaque handles; production still validates real handles.
 * Include system fields, the complete previous report and every coordination field.
 */
export async function fillAssignment(ctx: MutationCtx, id: Doc<"assignments">["_id"]) {
  const row = (await ctx.db.get("assignments", id))!;
  const growth = LIMITS.assignmentBytes - getConvexSize(row);

  if (growth < 0) throw new Error("FIXTURE_ASSIGNMENT_TOO_LARGE");

  await ctx.db.patch("assignments", id, { runTurn: row.runTurn + "x".repeat(growth) });
}

/** Maximum notes coexist with ready work without joining cancel's ready range. */
export async function fillNotes(ctx: MutationCtx, row: Doc<"assignments">) {
  for (let i = 0; i < row.limits.notesPending; i++)
    await ctx.db.insert("inbox", {
      assignmentId: row._id,
      runId: row.runId!,
      messageId: "",
      sequence: row.nextSequence + i,
      kind: "note",
      passive: true,
      noteEpoch: row.cancellationEpoch,
      text: "\uFFFF".repeat(LIMITS.noteLength),
      from: "\uFFFF".repeat(LIMITS.requestKeyLength),
    });

  await ctx.db.patch("assignments", row._id, { notesPending: row.limits.notesPending });
}
