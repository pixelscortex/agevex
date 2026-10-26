import { type CoordinatorCtx, type RuntimeContext } from "../registration/context.js";
import type { CoordinateArgs } from "../types.js";
type LaunchArgs = Extract<CoordinateArgs, {
    op: "launch";
}>;
/**
 * Launch one child run for the actor's currently running turn.
 *
 * The caller's capability (assignment + running turn token + native tool call
 * id) is validated before any policy call or write; a denial is a tool result,
 * never a thrown error. Returns `queued` with the run id for a fresh launch and
 * for an idempotent replay of the same tool call.
 */
export declare function launchChild(rt: RuntimeContext, ctx: CoordinatorCtx, args: LaunchArgs): Promise<{
    status: "denied";
    code: "ACTIVE_LIMIT" | "TASK_LIMIT" | "FORBIDDEN" | "STALE_TURN" | "DELEGATION_CONFLICT" | "RUN_BUDGET" | "RESULTS_PENDING" | "DEPTH_LIMIT" | "GROUP_LIMIT" | "GROUP_CLOSED" | "GROUP_CONFLICT";
    runId?: undefined;
    agent?: undefined;
} | {
    status: "queued";
    runId: string;
    agent: string;
    code?: undefined;
}>;
export {};
