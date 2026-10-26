/** Exact assistant identities accumulated inside the native save transaction. */
import type { MessageDoc } from "@convex-dev/agent";
import { getConvexSize } from "convex/values";
import type { Doc } from "../_generated/dataModel.js";
import { LIMITS } from "../limits.js";

/** Agent 0.7.7 vercel/client/start.ts:358-412 saves at most one assistant row
 * per single-step slice and returns its committed id. Bound the entire reporting
 * turn, including approval resumes: turnStepLimit(settings, slicesPerTurn)
 * <=64 ids * (128 UTF-8 bytes +1 Convex string terminator) =8,256 bytes.
 * Prompt, cap and resume-inbox metadata fit the remaining 1 KiB reservation.
 * The 40 KiB assignment envelope reserves 9 KiB for this state. Never retain
 * content or discover ids by reading history. Throwing rolls back native saves
 * too, so overflow cannot commit an assistant row without its identity.
 */
export function appendTurnMessages(row: Doc<"assignments">, messages: MessageDoc[]) {
  const report = row.turnReport;

  const ids = messages
    .filter((m) => m.status === "success" && m.message?.role === "assistant")
    .map((m) => String(m._id));

  // Low-level fences may save placeholders before a reporting claim exists.
  if (!report || !ids.length) return report;

  if (ids.some((id) => getConvexSize(id) > LIMITS.messageIdBytes + 1))
    throw new Error("MESSAGE_ID_TOO_LARGE");

  const messageIds = [...report.messageIds, ...ids];

  if (messageIds.length > report.maxMessages) throw new Error("TURN_MESSAGE_LIMIT");

  row.turnReport = { ...report, messageIds };

  return row.turnReport;
}
