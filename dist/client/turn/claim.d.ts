import type { RunnerCtx, RuntimeContext } from "../registration/context.js";
import type { ManagedAgent, TurnArgs } from "../types.js";
import type { Turn } from "./context.js";
/**
 * Load the execution this action was scheduled for, or `null` when the action
 * is stale (cancelled, superseded token) or blocked on a recorded approval.
 * Throws `UNKNOWN_AGENT` when the stored agent is no longer registered.
 */
export declare function loadExecution(rt: RuntimeContext, ctx: RunnerCtx, args: TurnArgs): Promise<{
    queued: {
        agent: string;
        runTurn: string;
        turnStatus: "idle" | "running" | "queued" | "recovery_required";
        turnToken: string | undefined;
        cancellationEpoch: number;
        cancelled: boolean;
        approvalBlocked: boolean;
        messageIds: string[];
        attachmentBytes: number;
    };
    managed: ManagedAgent;
} | null>;
/**
 * Claim the turn and build its `Turn`, or `null` when the claim is refused
 * (another action owns it, or it was cancelled in between).
 *
 * `notes` are the native handles the claim uses
 * to move pending notes into the transcript at this safe point.
 */
export declare function claimTurn(rt: RuntimeContext, ctx: RunnerCtx, args: TurnArgs, queued: Turn["queued"], managed: ManagedAgent): Promise<Turn | null>;
