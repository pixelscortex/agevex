/**
 * Per-agent model overrides: the validator and its byte/count bounds. A run
 * snapshots these at acceptance (turns/send.ts) and beforeTurn hooks may
 * update the current agent's choice (hooks/state.ts). Also used by the client.
 */
import { getConvexSize, v } from "convex/values";
import { LIMITS } from "./limits.js";
export const modelOverrides = v.record(v.string(), v.string());
/** Runs are read once per queued row during cancel. Keep the entire map at
 * <=512 Convex bytes, reserving room alongside the run settings map in the
 * 16 KiB runs envelope. newRun also validates the complete JSON byte envelope. Character caps alone
 * cannot provide that guarantee for UTF-8 agent names and model ids.
 */
export function validModelOverrides(models) {
    return (Object.keys(models).length <= LIMITS.modelOverrides &&
        Object.entries(models).every(([agent, id]) => agent.length > 0 &&
            agent.length <= LIMITS.requestKeyLength &&
            id.length > 0 &&
            id.length <= LIMITS.modelIdLength) &&
        getConvexSize(models) <= LIMITS.modelOverridesBytes);
}
