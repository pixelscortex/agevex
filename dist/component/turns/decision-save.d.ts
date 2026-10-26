import type { MessageDoc } from "@convex-dev/agent";
import type { Doc } from "../_generated/dataModel.js";
import type { MutationCtx } from "../_generated/server.js";
import type { AskUserMetadata } from "../../shared/tool-markers.js";
type NativeSave = {
    messages: {
        message: MessageDoc["message"];
    }[];
};
/** Recheck persisted role before any ask_user deferral, including direct saves.
 * Factory schema is trusted host metadata, never a model-supplied form program.
 * The extra run read is fixed at <=16 KiB per native save, independent of calls.
 */
export declare function prepareDecisions(ctx: MutationCtx, row: Doc<"assignments">, args: NativeSave, tools?: Record<string, AskUserMetadata>): Promise<void>;
/** Only pending input is bounded. Reasoning/text stays in native Agent storage.
 * The caller commits APPROVAL_LIMIT before native save rather than rolling back
 * a paid model step with an untyped generation failure.
 */
export declare function oversizedDecisionInput(messages: NativeSave["messages"], deferred: Set<string>): boolean;
export {};
