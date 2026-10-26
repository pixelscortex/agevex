import type { CoordinatorCtx, RuntimeContext } from "../registration/context.js";
import type { CoordinateArgs } from "../types.js";
type MessageArgs = Extract<CoordinateArgs, {
    op: "message";
}>;
type AskArgs = Extract<CoordinateArgs, {
    op: "ask";
}>;
/**
 * Run one `message` or `ask` interaction for the actor's running turn.
 *
 * Denials (bad length, stale token, no edge, unknown agent, policy refusal) are
 * returned as tool results before any native write.
 */
export declare function interact(rt: RuntimeContext, ctx: CoordinatorCtx, args: MessageArgs | AskArgs): Promise<{
    status: "accepted";
    runId: string;
} | {
    status: "denied";
    code: "TASK_LIMIT";
} | {
    status: "denied";
    code: "FORBIDDEN" | "STALE_TURN" | "RUN_BUDGET" | "CHILD_FINISHED" | "MESSAGE_LIMIT" | "SIDE_RUN" | "MESSAGE_RATE_LIMIT" | "NO_PARENT" | "ASK_PENDING" | "ASK_WITH_CHILDREN" | "QUEUE_LIMIT";
}>;
export {};
