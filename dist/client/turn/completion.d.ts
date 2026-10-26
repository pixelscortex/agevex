import type { MessageDoc } from "@convex-dev/agent";
import { type RuntimeContext } from "../registration/context.js";
import { type Generation, type TurnOutcome } from "./context.js";
/** The native step result `streamText` resolved with. */
type StepResult = {
    savedMessages?: MessageDoc[];
};
/**
 * Apply the post-step decisions. Returns `null` when the turn has been handed on
 * (fenced out, paused or continued), else the successful outcome to finalize.
 */
export declare function completeGeneration(rt: RuntimeContext, gen: Generation, result: StepResult, reason: string): Promise<TurnOutcome | null>;
export {};
