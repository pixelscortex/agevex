import { getConvexSize } from "convex/values";
import { LIMITS } from "../limits.js";
/** Agent 0.7.7 vercel/client/start.ts:358-412 saves at most one assistant row
 * per single-step slice and returns its committed id. Bound the entire reporting
 * turn, including approval resumes: turnStepLimit(settings, slicesPerTurn)
 * <=64 ids * (37 ASCII bytes +2 Convex string bytes) =2,496 bytes.
 * Convex id_v6.rs:33-49 encodes 23 binary bytes as <=37 base32 characters.
 * The full report, including prompt/cap/resume metadata, is <=2,653 bytes;
 * the 16 KiB assignment envelope reserves 3 KiB for this state. Never retain
 * content or discover ids by reading history. Throwing rolls back native saves
 * too, so overflow cannot commit an assistant row without its identity.
 */
export function appendTurnMessages(row, messages) {
    const report = row.turnReport;
    const ids = messages
        .filter((m) => m.status === "success" && m.message?.role === "assistant")
        .map((m) => String(m._id));
    // Low-level fences may save placeholders before a reporting claim exists.
    if (!report || !ids.length)
        return report;
    // Convex strings cost UTF-8 bytes +2. Equality with the character count
    // additionally rejects non-ASCII ids, even when they are fewer than 37 units.
    if (ids.some((id) => id.length > LIMITS.messageIdBytes || getConvexSize(id) !== id.length + 2))
        throw new Error("MESSAGE_ID_TOO_LARGE");
    const messageIds = [...report.messageIds, ...ids];
    if (messageIds.length > report.maxMessages)
        throw new Error("TURN_MESSAGE_LIMIT");
    row.turnReport = { ...report, messageIds };
    if (getConvexSize(row.turnReport) > LIMITS.turnReportBytes)
        throw new Error("TURN_REPORT_TOO_LARGE");
    return row.turnReport;
}
