// The cancellation fence around one turn's generation.
//
// Cancellation cannot be made atomic with a running action, so the turn fences it
// three ways: a deadline and a poll that abort the model call (cooperative
// providers), `assertActive` before every new nested call (admission fencing),
// and a fenced action context whose every native write goes through
// `turns.slices.write`, which re-checks the execution, token and epoch in the write's own
// transaction (the transactional write fence). Built by `turn/generation.ts`;
// the model call, hooks, slot tools, hook notes use
// `TurnFence.ctx`. Receipt-bound tools (`bindOnceTool`) get the raw context plus
// explicit fence args, and the runner's own control reads and writes (usage
// reporting, the post-step snapshot, `continueAfterToolCalls`) use `Turn.rawCtx`.

import { createFunctionHandle, getFunctionAddress } from "convex/server";
import { ConvexError } from "convex/values";
import { sliceDeadlineMs } from "../../component/run_settings.js";
import { LIMITS } from "../../component/limits.js";
import { askUserTools, type AskUserSave } from "../../shared/tool-markers.js";
import { deferredToolNames } from "../registration/graph.js";
import type { RunnerCtx, RuntimeContext } from "../registration/context.js";
import { stillRunning, type Turn } from "./context.js";
import { recordStepUsage } from "./slots.js";

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

/** Whether the fence has observed that this turn lost its execution. */
type FenceState = { fencedOut: boolean };

/** Stable identity of a function reference, for comparing native refs. */
function functionKey(ref: Parameters<RunnerCtx["runMutation"]>[0]): string {
  return JSON.stringify(getFunctionAddress(ref));
}

/**
 * Start the fence: arm the generation deadline and the cancellation poll, and
 * build the fenced action context. The caller must call `stop()`.
 */
export function startTurnFence(rt: RuntimeContext, turn: Turn): TurnFence {
  const controller = new AbortController();
  const state: FenceState = { fencedOut: false };

  const fenceOut = () => {
    state.fencedOut = true;
    controller.abort();
  };

  const timers = new Set<ReturnType<typeof setTimeout>>();

  const deadline = (ms: number) => {
    const timer = setTimeout(() => controller.abort(new Error("RUN_TIMEOUT")), ms);

    timers.add(timer);

    return () => {
      clearTimeout(timer);
      timers.delete(timer);
    };
  };

  controller.signal.addEventListener("abort", () => {
    state.fencedOut = true;
  });

  deadline(sliceDeadlineMs(turn.claimed.settings));

  const poll = setInterval(() => {
    void turn.rawCtx
      .runQuery(rt.component.turns.slices.execution, { assignmentId: turn.args.assignmentId })
      .then((row) => {
        if (!stillRunning(row, turn)) fenceOut();
      })
      .catch(fenceOut);
  }, LIMITS.cancelPollMs);

  // Route native saves and tool mutations through one atomic check.
  // Polling aborts cooperative providers; this fence also catches an
  // uncooperative provider that returns after cancellation.
  const nativeCtx = nativeWriteContext(rt, turn, state);

  const assertActive = async () => {
    const row = await turn.rawCtx.runQuery(rt.component.turns.slices.execution, {
      assignmentId: turn.args.assignmentId,
    });

    if (controller.signal.aborted || !stillRunning(row, turn)) {
      fenceOut();
      throw new ConvexError({ code: "CANCELLED" });
    }
  };

  const ctx = fencedContext(rt, turn, nativeCtx, assertActive, controller);

  return {
    controller,
    ctx,
    assertActive,
    deadline,
    wait: (work) => waitForSignal(controller.signal, work),
    stop: () => {
      for (const timer of timers) clearTimeout(timer);

      clearInterval(poll);
    },
  };
}

/**
 * Action context whose `runMutation` always goes through `turns.slices.write`.
 *
 * Once fenced out it drops every write except the native placeholder close
 * (`finalizeMessage`), which an abort listener may still issue for its own
 * recorded placeholder.
 */
function nativeWriteContext(rt: RuntimeContext, turn: Turn, state: FenceState): RunnerCtx {
  const { rawCtx, args, claimed, managed } = turn;
  const finalizeKey = functionKey(managed.component.messages.finalizeMessage);

  return {
    ...rawCtx,
    runMutation: (async (ref: Parameters<RunnerCtx["runMutation"]>[0], payload: unknown) => {
      // An abort listener may only close its own recorded placeholder.
      // turns.slices.write verifies the exact handle, id, execution and epoch.
      if (state.fencedOut && functionKey(ref) !== finalizeKey) return null;

      return rawCtx.runMutation(rt.component.turns.slices.write, {
        assignmentId: args.assignmentId,
        executionId: args.turnToken,
        cancellationEpoch: claimed.cancellationEpoch,
        handle: await createFunctionHandle(ref),
        args: payload,
      });
    }) as RunnerCtx["runMutation"],
  };
}

/**
 * The fenced context handed to the model, tools, hooks and slots.
 *
 * After cancel, the SDK refuses new nested calls and drops its own
 * writes; writes your own code makes inside an already-running nested
 * action are yours to guard with tc.signal. An action call cannot be
 * made atomic with the cancel mutation: this is admission fencing,
 * while SDK-owned/native writes retain the transactional write fence.
 * Agent 0.7.7 fires these void saves from asynchronous abort listeners.
 * They must resolve after cancellation to avoid an unhandled rejection;
 * turns.slices.write permits only their own terminal close after the fence. All other
 * native operations, including createTool's injected ctx, reject new
 * nested calls after revocation just like defineOnceTool does.
 */
function fencedContext(
  rt: RuntimeContext,
  turn: Turn,
  nativeCtx: RunnerCtx,
  assertActive: () => Promise<void>,
  controller: AbortController,
): RunnerCtx {
  const { rawCtx, managed } = turn;

  const nativeFinalizers = new Set(
    [managed.component.messages.finalizeMessage, managed.component.streams.abort].map(functionKey),
  );

  const addMessagesKey = functionKey(managed.component.messages.addMessages);

  return {
    ...nativeCtx,
    runAction: (async (ref, ...payload) => {
      await assertActive();

      return rawCtx.runAction(ref, ...payload);
    }) as RunnerCtx["runAction"],
    runMutation: (async (ref, payload) => {
      if (nativeFinalizers.has(functionKey(ref))) return nativeCtx.runMutation(ref, payload);

      await assertActive();

      try {
        const saved = await rawCtx.runMutation(
          rt.component.turns.slices.write,
          await fencedWriteArgs(turn, ref, payload),
        );

        if (functionKey(ref) === addMessagesKey) {
          // The native transaction committed this evidence even if cancellation
          // follows before the model result reaches the host action.
          const messages = (saved as { messages?: { usage?: unknown; status: string }[] } | null)
            ?.messages;

          if (messages?.some((message) => message.usage && message.status === "success"))
            turn.usageSaved = true;

          if (rt.config.usage) await recordStepUsage(rt, turn, rt.config.usage, saved);
        }

        return saved;
      } catch (error) {
        if (error instanceof ConvexError && error.data?.code === "CANCELLED") controller.abort();

        throw error;
      }
    }) as RunnerCtx["runMutation"],
  };
}

/**
 * `turns.slices.write` arguments for one fenced native mutation.
 *
 * `rejectStale` makes a fenced-out write throw `CANCELLED` instead of silently
 * returning. A native stream start also passes the stream-abort handle so the
 * component can close it on cancel; a native message save also passes what the
 * component needs to record deferred tool calls
 * from that same save, without any transcript discovery.
 */
async function fencedWriteArgs(
  turn: Turn,
  ref: Parameters<RunnerCtx["runMutation"]>[0],
  payload: unknown,
) {
  const { args, claimed, managed } = turn;
  const key = functionKey(ref);

  return {
    assignmentId: args.assignmentId,
    executionId: args.turnToken,
    cancellationEpoch: claimed.cancellationEpoch,
    handle: await createFunctionHandle(ref),
    args: payload,
    rejectStale: true,
    ...(key === functionKey(managed.component.streams.create)
      ? { nativeStream: await createFunctionHandle(managed.component.streams.abort) }
      : {}),
    ...(key === functionKey(managed.component.messages.addMessages)
      ? {
          // Tools without execute are native deferred calls (Agent
          // 0.7.7 example/convex/chat/human.ts:125-157). Supply
          // names only at the native-save seam; no transcript scan.
          askUserTools: await askUserTools(managed.declaredTools, payload as AskUserSave),
          deferredTools: deferredToolNames(managed),
          nativeMessages: {
            getMessages: await createFunctionHandle(managed.component.messages.getMessagesByIds),
            finalizeMessage: await createFunctionHandle(managed.component.messages.finalizeMessage),
          },
        }
      : {}),
  };
}

/** Bounded waiting does not claim that a timed-out external effect failed. */
function waitForSignal<T>(signal: AbortSignal, work: PromiseLike<T>): Promise<T> {
  if (signal.aborted) {
    // The work may have thrown synchronously while aborting a hook. Observe its
    // eventual rejection even though revocation already wins this race.
    void Promise.resolve(work).catch(() => {});

    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const abort = () => {
      signal.removeEventListener("abort", abort);
      reject(signal.reason);
    };

    signal.addEventListener("abort", abort, { once: true });

    Promise.resolve(work)
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}
