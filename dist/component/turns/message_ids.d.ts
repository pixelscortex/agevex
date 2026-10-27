/** Exact assistant identities accumulated inside the native save transaction. */
import type { MessageDoc } from "@convex-dev/agent";
import type { Doc } from "../_generated/dataModel.js";
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
export declare function appendTurnMessages(row: Doc<"assignments">, messages: MessageDoc[]): {
    resumeInboxId?: import("convex/values").GenericId<"inbox"> | undefined;
    promptMessageId: string;
    messageIds: string[];
    maxMessages: number;
} | undefined;
