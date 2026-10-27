// How the optional host slots take part in one turn.
//
// usage: `recordStepUsage` reports the model step a native save just captured.
// sandbox tools: `slotToolBags` asks each slot for its tools.
// telemetry: `telemetryIntegrations` per generation, `flushTelemetry` per action.
// Every slot is fail-open for evidence (usage, telemetry) and never retries paid
// work. Called from `turn/generation.ts`, `turn/tools.ts`, `turn/fence.ts` and
// `turn/run-turn.ts`.
import { LIMITS } from "../../component/limits.js";
import { opaqueKey } from "../keys.js";
import { sliceKey } from "./context.js";
import { markUsagePartial } from "./usage.js";
/**
 * Report the model step one native message save just captured.
 *
 * Agent 0.7.7 start.ts:382-417 saves step usage with its
 * native result. turns.slices.write returns those committed documents;
 * no transcript discovery is needed.
 * The fenced native save returns the committed document and exact identity;
 * no duplicate step reference or follow-up execution read is needed.
 */
export async function recordStepUsage(rt, turn, usage, saved) {
    const messages = saved?.messages ?? [];
    const step = messages.find((message) => message.usage && message.status === "success");
    if (!step?.usage)
        return;
    try {
        const requestId = step.providerMetadata?.agevex?.requestId;
        await usage.record(turn.rawCtx, {
            ...turn.facts,
            purpose: "agent",
            model: step.model,
            provider: step.provider,
            key: await opaqueKey("model", turn.facts.threadId, step._id, step.stepOrder),
            messageId: String(step._id),
            usage: step.usage,
            providerMetadata: step.providerMetadata,
            ...(typeof requestId === "string" ? { requestId } : {}),
        });
    }
    catch {
        await markUsagePartial(rt, turn);
        // Billing evidence is best effort. Never replay a paid
        // generation because its usage hook was unavailable.
    }
}
/**
 * Tool bags the configured slots contribute to this turn: sandbox tools only
 * for agents that opted in. Each
 * bag gets an opaque per-slice call key.
 */
export async function slotToolBags(rt, turn, hc) {
    const { config } = rt;
    const bags = [];
    if (turn.managed.sandbox && config.sandbox)
        bags.push(config.sandbox.tools({ ...hc, toolCallId: await slotCallKey(turn) }));
    return bags;
}
function slotCallKey(turn) {
    return opaqueKey("slot-call", turn.facts.runId, sliceKey(turn));
}
/** Telemetry integrations for one generation; a throwing slot yields none. */
export function telemetryIntegrations(config, facts, turnKey) {
    try {
        return [config.telemetry.integration({ ...facts, turnKey })];
    }
    catch {
        return [];
    }
}
/**
 * Flush telemetry once per `runTurn` action, bounded in time.
 *
 * Race even uncooperative exporters; abort alone cannot bound an
 * arbitrary Promise. One action spends at most three seconds
 * (`LIMITS.telemetryFlushMs`). Export failures never change turn state.
 */
export async function flushTelemetry(config, facts, turnKey) {
    if (!config.telemetry)
        return;
    const controller = new AbortController();
    let timer;
    try {
        await Promise.race([
            Promise.resolve().then(() => config.telemetry.flush({ ...facts, turnKey }, controller.signal)),
            new Promise((resolve) => {
                timer = setTimeout(() => {
                    controller.abort();
                    resolve();
                }, LIMITS.telemetryFlushMs);
            }),
        ]);
    }
    catch {
        /* Export failures never change turn state. */
    }
    finally {
        clearTimeout(timer);
    }
}
