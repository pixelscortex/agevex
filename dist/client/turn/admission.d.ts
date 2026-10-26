import type { RuntimeContext } from "../registration/context.js";
import type { Activity } from "../types.js";
import type { Turn } from "./context.js";
/**
 * Admit one claimed turn for generation. Returns `null` when admitted, else the
 * error code the turn finishes with. Every failure mode of the host callbacks
 * (throwing included) refuses: execution is never admitted by default.
 */
export declare function admitExecution(rt: RuntimeContext, turn: Turn): Promise<Activity["errorCode"]>;
