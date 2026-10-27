// How the optional host slots take part in one turn.
//
// usage: `recordStepUsage` reports provider completion, including dropped saves.
// sandbox tools: `slotToolBags` asks each slot for its tools.
// telemetry: `telemetryIntegrations` per generation, `flushTelemetry` per action.
// Every slot is fail-open for evidence (usage, telemetry) and never retries paid
// work. Called from `turn/generation.ts`, `turn/tools.ts`, `turn/fence.ts` and
// `turn/run-turn.ts`.
import { LIMITS } from "../../component/limits.js";
import { opaqueKey } from "../keys.js";
import { sliceKey } from "./context.js";
import { markUsagePartial, deliverStepUsage } from "./usage.js";
import { settleUsageSave } from "./step-usage.js";
/** Report exactly one provider completion after its save succeeds or fails.
 * Preserve the existing native key; a dropped save uses the unique slice id in
 * its place. Retries reuse this one event, including its original timestamp. */
export async function recordStepUsage(rt, gen, failed) {
    const { turn, fence } = gen;
    if (!rt.config.usage || !gen.state.modelStarted)
        return;
    const step = turn.stepUsage;
    if (!step) {
        await markUsagePartial(rt, turn);
        return;
    }
    try {
        await settleUsageSave(turn, fence);
        const requestId = step.providerMetadata?.agevex?.requestId;
        const event = {
            ...turn.facts,
            purpose: "agent",
            model: step.model,
            provider: step.provider,
            key: await opaqueKey("model", turn.facts.threadId, step.native?._id ?? sliceKey(turn), step.native?.stepOrder ?? 0),
            messageId: step.native ? String(step.native._id) : null,
            status: fence.controller.signal.aborted ? "aborted" : failed ? "failed" : step.status,
            occurredAt: step.occurredAt,
            usage: step.usage,
            providerMetadata: step.providerMetadata,
            ...(typeof requestId === "string" ? { requestId } : {}),
        };
        await deliverStepUsage(rt.config.usage, turn, fence, event);
    }
    catch {
        await markUsagePartial(rt, turn);
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
