// One admitted turn's generation: exactly one native model step.
//
// `generateTurn` starts the cancellation fence, binds hook tasks to it, then runs
// the phases in order: extract admission, model selection (`routing.ts`), tool
// set (`tools.ts`), the native stream/generate call (`nativeGeneration`), and the
// post-step decisions (`completion.ts`). A throw from those phases becomes an
// outcome: a hook failure is HOOK_FAILED; a `beforeTurn` block finishes a root
// turn without an error code and settles a child run as EMPTY_RESULT; anything
// else is GENERATION_FAILED. Once the phases start, the fence is always stopped
// and, on a run-start slice of an agent with `beforeTurn`, the routing attempt
// is completed. A throw while assembling the generation (`startGeneration`)
// reaches neither and propagates. Called by `turn/run-turn.ts`.

import { boundedModel } from "./deadlines.js";
import { LIMITS } from "../../component/limits.js";
import { boundedDownload } from "./download.js";
import type { RuntimeContext } from "../registration/context.js";
import { scopedMeter } from "../slots.js";
import { bindTaskContext } from "../tasks.js";
import type { HookContext, Registration } from "../types.js";
import { completeGeneration } from "./completion.js";
import {
  sliceKey,
  type Generation,
  type GenerationState,
  type Turn,
  type TurnOutcome,
} from "./context.js";
import { startTurnFence } from "./fence.js";
import { hookRunner } from "./hook-runner.js";
import { completeRouting, selectTurnModel } from "./routing.js";
import { extractAttachedFiles, meterBackend, telemetryIntegrations } from "./slots.js";
import { buildTurnTools } from "./tools.js";
import { markUsagePartial } from "./usage.js";
import { assertBudget } from "./admission.js";

/**
 * Run one admitted turn's generation.
 *
 * Returns the outcome finalization should record, or `null` when the
 * generation already handed the turn on itself (continued it, finished a
 * child's question pause, or found it fenced out) and nothing is left to do.
 */
export async function generateTurn(rt: RuntimeContext, turn: Turn): Promise<TurnOutcome | null> {
  const gen = startGeneration(rt, turn);
  const { state } = gen;

  try {
    await extractAttachedFiles(rt, turn, gen.fence);
    const model = await selectTurnModel(rt, gen);
    const tools = await buildTurnTools(rt, gen);
    const { result, reason } = await nativeGeneration(rt, gen, tools, model);

    return await completeGeneration(rt, gen, result, reason);
  } catch {
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
  } finally {
    if (
      rt.config.usage &&
      state.modelStarted &&
      (gen.fence.controller.signal.aborted || !turn.usageSaved)
    )
      await markUsagePartial(rt, turn);

    gen.fence.stop();

    if (turn.claimed.isRunStart && turn.managed.hooks?.beforeTurn) await completeRouting(rt, turn);
  }
}

/**
 * Start the fence and assemble the `Generation`: hook tasks (`runTask` inside a
 * hook) are bound to the fenced context, so they share the turn's receipts and
 * cancellation fence; hooks get the hook-scoped meter.
 */
function startGeneration(rt: RuntimeContext, turn: Turn): Generation {
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

  const backend = meterBackend(rt.config, turn.rawCtx, { ...facts, purpose: "tool" }, () =>
    markUsagePartial(rt, turn),
  );

  const state: GenerationState = {
    modelStarted: false,
    hookFailed: false,
    hookBlocked: false,
    delegated: false,
    asked: false,
  };

  const hc: HookContext = {
    ctx: fence.ctx,
    ...facts,
    signal: fence.controller.signal,
    meter: scopedMeter(
      meterBackend(rt.config, turn.rawCtx, { ...facts, purpose: "hook" }, () =>
        markUsagePartial(rt, turn),
      ),
      `${sliceKey(turn)}:hook`,
    ),
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
async function nativeGeneration(
  rt: RuntimeContext,
  gen: Generation,
  tools: import("ai").ToolSet,
  selectedModel: string | null | undefined,
) {
  const { turn, fence } = gen;
  const { config } = rt;

  // Admission already checked this boundary. Only pre-model host work can
  // change observed spend before the call; do not read a policy twice otherwise.
  if (turn.managed.hooks?.beforeTurn || config.extract) await assertBudget(rt, gen);

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
    prepareStep: ({ model }: { model: import("ai").LanguageModel }) => ({
      model: boundedModel(gen, model),
    }),
    maxRetries: LIMITS.modelRetries,
    // Native stop conditions are evaluated after each step: exactly
    // one model step per slice.
    stopWhen: () => true,
    abortSignal: fence.controller.signal,
  };

  const target = { threadId: turn.claimed.threadId };
  const storageOptions = { saveMessages: "promptAndOutput" as const };

  if (turn.claimed.settings.mode === "generate") {
    const result = await fence.wait(
      turn.managed.generateText(fence.ctx, target, args, {
        storageOptions,
      }),
    );

    const reason = result.finishReason;

    assertComplete(gen, reason, false);

    return { result, reason };
  }

  const result = await fence.wait(
    turn.managed.streamText(fence.ctx, target, args, {
      saveStreamDeltas: { chunking: "word", throttleMs: LIMITS.streamThrottleMs },
      storageOptions,
    }),
  );

  let streamError = false;

  await fence.wait(
    result.consumeStream({
      onError: () => {
        streamError = true;
      },
    }),
  );

  const reason = await result.finishReason;

  assertComplete(gen, reason, streamError);

  return { result, reason };
}

/** A timeout or partial native response must never continue the logical turn. */
function assertComplete(gen: Generation, reason: string, streamError: boolean) {
  const { state, fence } = gen;
  const accepted = ["stop", "length", "tool-calls"];

  if (
    state.hookFailed ||
    streamError ||
    fence.controller.signal.aborted ||
    !accepted.includes(reason)
  )
    throw new Error("INCOMPLETE_GENERATION");
}

/** Resolve a stored model id; it must still be on the host allowlist. */
function resolveModel(config: Registration, selectedModel: string) {
  if (!config.models || !config.modelAllowlist?.includes(selectedModel))
    throw new Error("MODEL_NOT_ALLOWED");

  return config.models(selectedModel);
}
