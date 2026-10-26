import type { RunnerCtx, RuntimeContext } from "../registration/context.js";
import { type Turn } from "./context.js";
/** The live fence of one generation. */
export type TurnFence = {
    /** Aborted by the deadline, a fenced-out poll, a refused write or a failed hook. */
    controller: AbortController;
    /** The fenced action context every managed write of this turn goes through. */
    ctx: RunnerCtx;
    /** Throws `CANCELLED` (and aborts) once the turn no longer owns a running execution. */
    assertActive: () => Promise<void>;
    /** Arm a phase deadline; aborting fences the whole slice and late writes. */
    deadline: (ms: number) => () => void;
    /** Race even uncooperative providers/tools against revocation. */
    wait: <T>(work: PromiseLike<T>) => Promise<T>;
    /** Stop the deadline timer and the poll; called when generation ends. */
    stop: () => void;
};
/**
 * Start the fence: arm the generation deadline and the cancellation poll, and
 * build the fenced action context. The caller must call `stop()`.
 */
export declare function startTurnFence(rt: RuntimeContext, turn: Turn): TurnFence;
