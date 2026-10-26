import type { RuntimeContext } from "../registration/context.js";
import type { Activity } from "../types.js";
import type { Turn, Generation } from "./context.js";
/** Snapshot before the next model/tool boundary. In-flight work may overshoot;
 * this never reserves credits and never offers a resumable pause. */
export declare function assertBudget(rt: RuntimeContext, gen: Generation): Promise<void>;
/**
 * Admit one claimed turn for generation. Returns `null` when admitted, else the
 * error code the turn finishes with. Every failure mode of the host callbacks
 * (throwing included) refuses: execution is never admitted by default.
 */
export declare function admitExecution(rt: RuntimeContext, turn: Turn): Promise<Activity["errorCode"]>;
