import type { CoordinatorCtx, RuntimeContext } from "../registration/context.js";
import type { CoordinateArgs } from "../types.js";
/** Report progress using trusted persisted identities and the host delivery policy. */
export declare function messageParent(rt: RuntimeContext, ctx: CoordinatorCtx, args: Extract<CoordinateArgs, {
    op: "message_parent";
}>): Promise<{
    status: "denied";
    code: "FORBIDDEN" | "STALE_TURN" | "RUN_BUDGET" | "CHILD_FINISHED" | "MESSAGE_LIMIT" | "MESSAGE_TOO_LARGE" | "MESSAGE_EMPTY" | "MESSAGE_RATE_LIMIT" | "KEY_CONFLICT" | "NO_PARENT" | "ASK_PENDING" | "ASK_WITH_CHILDREN" | "QUEUE_LIMIT";
    messageId?: undefined;
} | {
    status: "accepted";
    messageId: string;
    code?: undefined;
}>;
