// One admitted turn's generation: exactly one native model step.
//
// `generateTurn` starts the cancellation fence, binds hook tasks to it, then runs
// the phases in order: model selection (`routing.ts`), tool
// set (`tools.ts`), the native stream/generate call (`nativeGeneration`), and the
// post-step decisions (`completion.ts`). A throw from those phases becomes an
// outcome: a hook failure is HOOK_FAILED; a `beforeTurn` block finishes a root
// turn without an error code and settles a child run as EMPTY_RESULT; anything
// else is GENERATION_FAILED. Once the phases start, the fence is always stopped
// A throw while assembling the generation (`startGeneration`) propagates. Called by `turn/run-turn.ts`.
import { boundedModel } from "./deadlines.js";
import { LIMITS } from "../../component/limits.js";
import { boundedDownload } from "./download.js";
import { bindTaskContext } from "../tasks.js";
import { completeGeneration } from "./completion.js";
import {} from "./context.js";
import { startTurnFence } from "./fence.js";
import { hookRunner } from "./hook-runner.js";
import { selectTurnModel } from "./routing.js";
import { recordStepUsage, telemetryIntegrations } from "./slots.js";
import { buildTurnTools } from "./tools.js";
import { assertBudget } from "./admission.js";
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
    let usageReported = false;
    try {
        const model = await selectTurnModel(rt, gen);
        const tools = await buildTurnTools(rt, gen);
        const { result, reason } = await nativeGeneration(rt, gen, tools, model);
        // Publish usage before continuation can admit another slice or budget check.
        await recordStepUsage(rt, gen, false);
        usageReported = true;
        return await completeGeneration(rt, gen, result, reason);
    }
    catch {
        const timedOut = gen.fence.controller.signal.reason?.message === "RUN_TIMEOUT";
        return {
            errorCode: state.budgetExceeded
                ? "BUDGET_EXCEEDED"
                : state.hookFailed
                    ? "HOOK_FAILED"
                    : state.hookBlocked
                        ? null
                        : timedOut
                            ? "RUN_TIMEOUT"
                            : "GENERATION_FAILED",
            childError: state.budgetExceeded
                ? "BUDGET_EXCEEDED"
                : state.hookFailed
                    ? "HOOK_FAILED"
                    : state.hookBlocked
                        ? "EMPTY_RESULT"
                        : timedOut
                            ? "RUN_TIMEOUT"
                            : "GENERATION_FAILED",
        };
    }
    finally {
        if (!usageReported)
            await recordStepUsage(rt, gen, true);
        gen.fence.stop();
    }
}
/**
 * Start the fence and assemble the `Generation`: hook tasks (`runTask` inside a
 * hook) are bound to the fenced context, so they share the turn's receipts and
 * cancellation fence.
 */
function startGeneration(rt, turn) {
    const { args, claimed, facts, turnKey } = turn;
    const fence = startTurnFence(rt, turn);
    bindTaskContext(fence.ctx, {
        component: rt.component,
        attribution: { ...facts, purpose: "hook" },
        turnKey,
        usage: rt.config.usage,
        fence: {
            assignmentId: args.assignmentId,
            executionId: args.turnToken,
            cancellationEpoch: claimed.cancellationEpoch,
        },
    });
    const state = {
        modelStarted: false,
        hookFailed: false,
        hookBlocked: false,
        delegated: false,
        asked: false,
    };
    const hc = {
        ctx: fence.ctx,
        ...facts,
        promptMessageId: claimed.requestMessageId,
        signal: fence.controller.signal,
    };
    const hook = hookRunner(rt, turn, fence, state);
    return { turn, fence, hc, hook, state };
}
/**
 * Run the native model call for exactly one step and require a clean finish.
 *
 * Throws `INCOMPLETE_GENERATION` when a hook failed, the stream errored, the
 * fence aborted, or the finish reason is not one a step may end with.
 */
async function nativeGeneration(rt, gen, tools, selectedModel) {
    const { turn, fence } = gen;
    const { config } = rt;
    // Admission already checked this boundary. Only pre-model host work can
    // change observed spend before the call; do not read a policy twice otherwise.
    if (turn.managed.hooks?.beforeTurn)
        await assertBudget(rt, gen);
    const args = {
        promptMessageId: turn.claimed.promptMessageId,
        // Agent 0.7.7 vercel/client/start.ts:107-108,234 supports this
        // per-call override natively; never mutate a shared Agent's options.
        ...(selectedModel ? { model: resolveModel(config, selectedModel) } : {}),
        tools,
        ...(config.telemetry
            ? { telemetry: { integrations: telemetryIntegrations(config, turn.facts, turn.turnKey) } }
            : {}),
        experimental_download: boundedDownload(turn.queued.attachmentBytes, fence.controller.signal),
        maxOutputTokens: turn.claimed.settings.maxOutputTokens,
        toolCallConcurrency: 1,
        prepareStep: ({ model }) => ({
            model: boundedModel(gen, model),
        }),
        maxRetries: LIMITS.modelRetries,
        // Native stop conditions are evaluated after each step: exactly
        // one model step per slice.
        stopWhen: () => true,
        abortSignal: fence.controller.signal,
    };
    const target = { threadId: turn.claimed.threadId };
    const storageOptions = { saveMessages: "promptAndOutput" };
    if (turn.claimed.settings.mode === "generate") {
        const result = await fence.wait(turn.managed.generateText(fence.ctx, target, args, {
            storageOptions,
        }));
        const reason = result.finishReason;
        assertComplete(gen, reason, false);
        return { result, reason };
    }
    const result = await fence.wait(turn.managed.streamText(fence.ctx, target, args, {
        saveStreamDeltas: { chunking: "word", throttleMs: LIMITS.streamThrottleMs },
        storageOptions,
    }));
    let streamError = false;
    await fence.wait(result.consumeStream({
        onError: () => {
            streamError = true;
        },
    }));
    const reason = await result.finishReason;
    assertComplete(gen, reason, streamError);
    return { result, reason };
}
/** A timeout or partial native response must never continue the logical turn. */
function assertComplete(gen, reason, streamError) {
    const { state, fence } = gen;
    const accepted = ["stop", "length", "tool-calls"];
    if (state.hookFailed ||
        streamError ||
        fence.controller.signal.aborted ||
        !accepted.includes(reason))
        throw new Error("INCOMPLETE_GENERATION");
}
/** Resolve a stored model id; it must still be on the host allowlist. */
function resolveModel(config, selectedModel) {
    if (!config.models || !config.modelAllowlist?.includes(selectedModel))
        throw new Error("MODEL_NOT_ALLOWED");
    return config.models(selectedModel);
}
