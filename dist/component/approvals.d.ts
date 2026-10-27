import type { Doc } from "./_generated/dataModel.js";
import type { MutationCtx } from "./_generated/server.js";
export declare const callKey: (id: string) => Promise<ArrayBuffer>;
export declare function keyString(digest: ArrayBuffer): string;
export declare function approvalKey(id: string): Promise<string>;
/** Agent 0.7.7's exact native response protocol, without its history planner. */
export declare function saveResponses(ctx: MutationCtx, target: {
    threadId: string;
    agent: string;
    messageId: string;
    addMessages: string;
}, responses: {
    approvalId: string;
    approved: boolean;
    reason?: string;
    providerExecuted?: true;
}[], deniedCalls?: {
    toolCallId: string;
    toolName: string;
    providerExecuted?: true;
}[]): Promise<string>;
/** Cleanup always blocks; decided requests remain recorded until their native
 * tool results commit, but only unresolved decisions prevent their resume. */
export declare function approvalBlocked(row: Pick<Doc<"assignments">, "approvals"> | null | undefined): boolean;
