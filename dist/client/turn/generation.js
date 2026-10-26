// One admitted turn's generation: exactly one native model step.
//
// `generateTurn` starts the cancellation fence, binds hook tasks to it, then runs
// the phases in order: extract admission, model selection (`routing.ts`), tool
// set (`tools.ts`), the native `streamText` call (`streamGeneration`), and the
// post-step decisions (`completion.ts`). A throw from those phases becomes an
// outcome: a hook failure is HOOK_FAILED; a `beforeTurn` block finishes a root
// turn without an error code and settles a child run as EMPTY_RESULT; anything
// else is GENERATION_FAILED. Once the phases start, the fence is always stopped
// and, on a run-start slice of an agent with `beforeTurn`, the routing attempt
// is completed. A throw while assembling the generation (`startGeneration`)
// reaches neither and propagates. Called by `turn/run-turn.ts`.
import { LIMITS } from "../../component/limits.js";
import { boundedDownload } from "./download.js";
import { scopedMeter } from "../slots.js";
import { bindTaskContext } from "../tasks.js";
import { completeGeneration } from "./completion.js";
import { sliceKey, } from "./context.js";
import { startTurnFence } from "./fence.js";
import { hookRunner } from "./hook-runner.js";
import { completeRouting, selectTurnModel } from "./routing.js";
import { extractAttachedFiles, meterBackend, telemetryIntegrations } from "./slots.js";
import { buildTurnTools } from "./tools.js";
/**
 * Run one admitted turn's generation.
 *
 * Returns the outcome finalization should record, or `null` when the
 * generation already handed the turn on itself (continued it, finished a
 * child's question pause, or found it fenced out) and nothing is left to do.
 */
export async function generateTurn(rt, turn) {
    const gen = startGeneration(rt, turn);
    const { state } = gen;
    try {
        await extractAttachedFiles(rt, turn, gen.fence);
        const model = await selectTurnModel(rt, gen);
        const tools = await buildTurnTools(rt, gen);
        const { result, reason } = await streamGeneration(rt, gen, tools, model);
        return await completeGeneration(rt, gen, result, reason);
    }
    catch {
        return {
            errorCode: state.hookFailed ? "HOOK_FAILED" : state.hookBlocked ? null : "GENERATION_FAILED",
            childError: state.hookFailed
                ? "HOOK_FAILED"
                : state.hookBlocked
                    ? "EMPTY_RESULT"
                    : "GENERATION_FAILED",
        };
    }
    finally {
        gen.fence.stop();
        if (turn.claimed.isRunStart && turn.managed.hooks?.beforeTurn)
            await completeRouting(rt, turn);
    }
}
/**
 * Start the fence and assemble the `Generation`: hook tasks (`runTask` inside a
 * hook) are bound to the fenced context, so they share the turn's receipts and
 * cancellation fence; hooks get the hook-scoped meter.
 */
function startGeneration(rt, turn) {
    const { args, claimed, facts, turnKey } = turn;
    const fence = startTurnFence(rt, turn);
    bindTaskContext(fence.ctx, {
        component: rt.component,
        attribution: facts,
        turnKey,
        usage: rt.config.usage,
        fence: {
            assignmentId: args.assignmentId,
            executionId: args.turnToken,
            cancellationEpoch: claimed.cancellationEpoch,
        },
    });
    const backend = meterBackend(rt.config, fence.ctx, facts);
    const state = {
        hookFailed: false,
        hookBlocked: false,
        delegated: false,
        asked: false,
    };
    const hc = {
        ctx: fence.ctx,
        ...facts,
        signal: fence.controller.signal,
        meter: scopedMeter(backend, `${sliceKey(turn)}:hook`),
    };
    const hook = hookRunner(rt, turn, fence, state);
    return { turn, fence, hc, hook, backend, state };
}
/**
 * Run the native model call for exactly one step and require a clean finish.
 *
 * Throws `INCOMPLETE_GENERATION` when a hook failed, the stream errored, the
 * fence aborted, or the finish reason is not one a step may end with.
 */
async function streamGeneration(rt, gen, tools, selectedModel) {
    const { turn, fence, state } = gen;
    const { config } = rt;
    const result = await turn.managed.streamText(fence.ctx, { threadId: turn.claimed.threadId }, {
        promptMessageId: turn.claimed.promptMessageId,
        // Agent 0.7.7 vercel/client/start.ts:107-108,234 supports this
        // per-call override natively; never mutate a shared Agent's options.
        ...(selectedModel ? { model: resolveModel(config, selectedModel) } : {}),
        tools,
        ...(config.telemetry
            ? { telemetry: { integrations: telemetryIntegrations(config, turn.facts, turn.turnKey) } }
            : {}),
        experimental_download: boundedDownload(turn.queued.attachmentBytes, fence.controller.signal),
        maxOutputTokens: LIMITS.outputTokens,
        maxRetries: LIMITS.modelRetries,
        // Native stop conditions are evaluated after each step: exactly
        // one model step per slice.
        stopWhen: () => true,
        abortSignal: fence.controller.signal,
    }, {
        saveStreamDeltas: { chunking: "word", throttleMs: LIMITS.streamThrottleMs },
        storageOptions: { saveMessages: "promptAndOutput" },
    });
    let streamError = false;
    await result.consumeStream({
        onError: () => {
            streamError = true;
        },
    });
    const reason = await result.finishReason;
    const accepted = ["stop", "length", "tool-calls"];
    if (state.hookFailed ||
        streamError ||
        fence.controller.signal.aborted ||
        !accepted.includes(reason))
        throw new Error("INCOMPLETE_GENERATION");
    return { result, reason };
}
/** Resolve a stored model id; it must still be on the host allowlist. */
function resolveModel(config, selectedModel) {
    if (!config.models || !config.modelAllowlist?.includes(selectedModel))
        throw new Error("MODEL_NOT_ALLOWED");
    return config.models(selectedModel);
}
