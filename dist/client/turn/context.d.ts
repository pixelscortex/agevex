import type { FunctionReturnType } from "convex/server";
import type { ComponentApi } from "../../component/_generated/component.js";
import type { RunnerCtx } from "../registration/context.js";
import type { MeterBackend, SlotFacts } from "../slots.js";
import type { Activity, HookContext, HookResult, ManagedAgent, RunErrorCode, TurnArgs } from "../types.js";
import type { TurnFence } from "./fence.js";
/** The `turns.slices.execution` row a turn is fenced against. */
export type Execution = FunctionReturnType<ComponentApi["turns"]["slices"]["execution"]>;
/** The facts `turns.slices.claim` returns for a claimed turn. */
export type Claimed = NonNullable<FunctionReturnType<ComponentApi["turns"]["slices"]["claim"]>>;
/** One claimed turn: everything later phases may assume. */
export type Turn = {
    /**
     * The raw, unfenced action context. Right for the runner's own control reads
     * and writes (claim checks, routing, finish, settle, fence polls) and for
     * `bindOnceTool`, which fences by explicit args; model, tool, hook and slot
     * work must use the fenced `Generation.fence.ctx` instead.
     */
    rawCtx: RunnerCtx;
    /** Native model usage committed before any later timeout/cancel. */
    usageSaved?: boolean;
    args: TurnArgs;
    queued: NonNullable<Execution>;
    managed: ManagedAgent;
    claimed: Claimed;
    /** Present exactly when this turn belongs to a delegated child run. */
    child: Claimed["subagent"];
    /** Opaque per-slice key for telemetry and hook-task receipts. */
    turnKey: string;
    /** Server-derived attribution handed to every slot. */
    facts: SlotFacts;
};
/** Flags generation sets while the model and its tools run. */
export type GenerationState = {
    /** Provider dispatch began; failed/dropped native saves must report partial. */
    modelStarted: boolean;
    budgetExceeded?: boolean;
    /** A hook threw or returned an invalid result: the turn reports HOOK_FAILED. */
    hookFailed: boolean;
    /** `beforeTurn` blocked the turn: no generation, no error code on the root. */
    hookBlocked: boolean;
    /** The model queued at least one delegation this step. */
    delegated: boolean;
    /** A child asked its parent a question this step (and now waits for the answer). */
    asked: boolean;
};
/** Runs one host hook under the turn's validation and failure rules. */
export type HookRunner = (invoke: (() => HookResult | Promise<HookResult>) | undefined, allowModel?: boolean) => Promise<HookResult>;
/** Everything that exists only while one turn's generation runs. */
export type Generation = {
    turn: Turn;
    fence: TurnFence;
    hc: HookContext;
    hook: HookRunner;
    backend: MeterBackend | undefined;
    state: GenerationState;
};
/** What a finished generation (or a refused admission) hands to finalization. */
export type TurnOutcome = {
    /** The turn's own queue outcome. */
    errorCode: Activity["errorCode"];
    /** The outcome a child turn settles its run with. */
    childError: RunErrorCode;
    /** The verified-later id of a child's final assistant message. */
    childResultMessageId?: string;
};
/** The key that names this slice: the slice id when sliced, else the turn token. */
export declare function sliceKey(turn: Turn): string;
/**
 * Whether the turn still owns its execution: same turn token, same cancellation
 * epoch, not cancelled. Re-checked before every terminal write so a cancelled or
 * superseded turn never finishes, continues or settles anything.
 */
export declare function stillOwns(row: Execution, turn: Turn): row is NonNullable<Execution>;
/** `stillOwns` and the turn is still `running` (the generation-time fence). */
export declare function stillRunning(row: Execution, turn: Turn): boolean;
