import type { MessageDoc } from "@convex-dev/agent";
import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";
import type { PreparedAskUser } from "../../shared/tool-markers.js";
type NativeSave = {
    messages: {
        message: MessageDoc["message"];
    }[];
};
/** Recheck persisted role before any ask_user deferral, including direct saves.
 * Factory schema is trusted host metadata, never a model-supplied form program.
 * The extra run read is fixed at <=16 KiB per native save, independent of calls.
 */
export declare function prepareDecisions(ctx: MutationCtx, row: Doc<"assignments">, args: NativeSave, tools?: Record<string, PreparedAskUser>): Promise<void>;
/** Only pending input is bounded. Reasoning/text stays in native Agent storage.
 * The caller commits APPROVAL_LIMIT before native save rather than rolling back
 * a paid model step with an untyped generation failure.
 *
 * Every unresulted deferred call must also be answerable: the pending read marks
 * an item truncated (unanswerable) when its identifiers or full projection exceed
 * the item bound, so refuse here what could never be answered once saved. Factory
 * asks are checked on their normalized form in `prepareDecisions` instead.
 */
export declare function oversizedDecisionInput(messages: NativeSave["messages"], deferred: Set<string>, owner: {
    threadId: string;
    agent: string;
}, asks?: Record<string, PreparedAskUser>): boolean;
export {};
