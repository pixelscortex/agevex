/// <reference types="vite/client" />
import { convexTest } from "convex-test";
import { makeFunctionReference, mutationGeneric, queryGeneric } from "convex/server";
import workflow from "@convex-dev/workflow/test";
import { type Registration } from "../src/client/types.js";
import agent from "@convex-dev/agent/test";
import { registerWorkflow } from "../src/test.js";
import type { GenericId } from "convex/values";
import agevex from "../src/test.js";
import schema from "./fixture/schema.js";
import type { MutationCtx } from "../src/component/_generated/server.js";
import type { Id } from "../src/component/_generated/dataModel.js";
import { state, fixtureRuntime } from "./host.js";

// The fixture app mirrors a real Convex host app: its `_generated` directory
// marks the functions root, and its `agents` module is the deterministic test
// registration in `tests/host.ts` rather than a separate app module.
const modules = import.meta.glob(["./fixture/**/*.ts", "./fixture/**/*.js"]);

/**
 * Injected component fault points.
 *
 * Each replaces one real component function with one that fails at exactly one
 * boundary, so the tested path is the real one up to that point.
 */
export type Fault =
  | "cleanupSave"
  | "transcriptReads"
  | "lostPing"
  | "delayedWait"
  | "save"
  | "accept"
  | "finish"
  | "attach"
  | "deliver"
  | "settle"
  | "notificationSave"
  | "childFinish"
  | "acceptedDelivery";

/** Shape of the `addMessages` argument the notification fault inspects. */
type AddMessagesArgs = {
  agentName?: string;
  messages: { message: { role: string } }[];
};

/** The registered Agent message mutation the fault wraps, by its handler. */
type NativeAddMessages = {
  _args: unknown;
  _returns: unknown;
  _handler: (ctx: MutationCtx, args: AddMessagesArgs) => Promise<unknown>;
};

/**
 * Agent-component fault: refuse the one native save that is a named agent's
 * user-role message.
 *
 * In this registration that is exactly the delivered parent notification, which
 * is saved as a user message carrying the delegated child's `agentName`. Task
 * prompts are user messages without an `agentName` and generated output is an
 * assistant message, so failing only that save models a delivery attempt that
 * cannot commit its native parent message while leaving the separate,
 * metadata-only failure record able to.
 *
 * The wrapper reuses the real mutation's own validators and handler, so every
 * other save on the path is the real one; only the boundary between them is
 * asserted.
 */
function notificationSaveFault(native: NativeAddMessages) {
  return mutationGeneric({
    args: native._args as never,
    returns: native._returns as never,
    handler: async (ctx, args) => {
      const nativeArgs = args as unknown as AddMessagesArgs;

      const isNotification =
        nativeArgs.agentName !== undefined &&
        nativeArgs.messages.some((entry) => entry.message.role === "user");

      if (isNotification) throw new Error("injected notification save failure");

      return (await native._handler(ctx as unknown as MutationCtx, nativeArgs)) as never;
    },
  });
}

/** The registered Agevex component mutation a conditional fault wraps. */
type AgevexMutation = {
  _handler: (ctx: unknown, args: unknown) => Promise<unknown>;
};

/** Arguments of `turns.slices.finish`, the only conditional-fault boundary on
 * a turn. */
type FinishArgs = { assignmentId: string; turnToken: string; errorCode: string | null };

/**
 * Turn fault: refuse the finalization of a delegated child turn only.
 *
 * A child turn is identified by the run it owns on its assignment, read from
 * the same table `turns.slices.finish` itself reads, so a root turn finalizes through
 * the real handler and only the child's release of its run fails. This is what
 * a child-only finalization fault looks like; the blanket `finish` fault is not
 * the same boundary.
 */
function childFinishFault(real: AgevexMutation) {
  return mutationGeneric({
    handler: async (ctx, args) => {
      const finishArgs = args as FinishArgs;

      const row = await (ctx as MutationCtx).db.get(
        "assignments",
        finishArgs.assignmentId as Id<"assignments">,
      );

      if (row?.childRunId) throw new Error("injected child finish failure");

      return (await real._handler(ctx, finishArgs)) as never;
    },
  });
}

/** Arguments of the one-shot `subagents.deliver.deliver` transition. */
type DeliverArgs = {
  runId: string;
  deliveryToken: string;
  deliveryStatus: "accepted" | "failed" | "blocked";
};

/**
 * Delivery fault: refuse the queue acceptance of a delivered result only.
 *
 * `attemptDelivery` saves the native parent message and then accepts it into the
 * component queue in the same transaction, so throwing on the accepted record
 * rolls that parent message back with it and leaves the separate, metadata-only
 * `failed` record — which this fault lets through — able to commit. Every other
 * `deliver` call, including the fallback failure record, is the real one.
 */
function acceptedDeliveryFault(real: AgevexMutation) {
  return mutationGeneric({
    handler: async (ctx, args) => {
      const deliverArgs = args as DeliverArgs;

      if (deliverArgs.deliveryStatus === "accepted")
        throw new Error("injected queue acceptance failure");

      return (await real._handler(ctx, deliverArgs)) as never;
    },
  });
}

export function setup(
  fault?: Fault,
  limits?: Registration["limits"],
  transactionLimits: NonNullable<Parameters<typeof convexTest>[0]>["transactionLimits"] = false,
) {
  state.run = undefined;
  state.deferred = false;
  state.deferredCount = 1;
  state.deferredQuestion = "Which option?";
  state.overrideCalls.length = 0;
  state.overrideTools = false;
  state.dropPing = false;
  state.forbidTranscriptReads = false;
  state.transcriptReads = 0;
  state.nestedCalls = 0;
  state.nativeNested = false;
  state.nestedAfterCancel = false;
  state.nestedStarted = false;
  state.nestedErrors.length = 0;
  state.nestedSignals.length = 0;
  state.nestedGate = undefined;
  state.nestedRelease = undefined;
  state.childToolSlices = 0;
  state.calls.length = 0;
  state.modelStarted = undefined;
  state.offers.length = 0;
  state.events.length = 0;
  state.observerFails = false;
  state.fail = false;
  state.revoke = false;
  state.denyFreshRequests = false;
  state.denyAllRequests = false;
  state.requestScopes.length = 0;
  state.hang = false;
  state.tools = false;
  state.approval = false;
  state.approvalCount = 1;
  state.echoStarted = false;
  state.echoGate = undefined;
  state.cleanupFails = false;
  state.childApproval = false;
  state.childDeferred = false;
  state.once = false;
  state.onceCalls = 0;
  state.onceContext = undefined;
  state.delegate = false;
  state.delegateFanout = 1;
  state.delegationRounds = 1;
  state.delegatedRounds = 0;
  state.roundsByPrompt.clear();
  state.delegateAgent = "Researcher";
  state.delegateTask = "research the bounded question";
  state.denyDelegate = false;
  state.denyDeliver = false;
  state.revokeChild = false;
  state.childText = "RESEARCHER deterministic native result";
  state.childFail = false;
  state.childDelayMs = 0;
  state.delayMs = 0;
  state.gate = undefined;
  state.release = undefined;
  state.childGate = undefined;
  state.childRelease = undefined;

  const t = convexTest({
    schema,
    transactionLimits,
    modules: {
      ...modules,
      "./fixture/agents.ts": async () => {
        const host = await import("./host.js");
        const runtime = fixtureRuntime(limits);

        return { ...host, ...runtime.internalFunctions(), ...runtime.authorizedEndpoints() };
      },
    },
  });

  const failure = mutationGeneric({
    handler: async () => {
      throw new Error("injected failure");
    },
  });

  if (fault === "save") {
    t.registerComponent("agent", agent.schema, {
      ...agent.modules,
      "./component/messages.ts": async () => ({
        ...((await agent.modules["./component/messages.ts"]()) as Record<string, unknown>),
        addMessages: failure,
      }),
    });
  } else if (fault === "cleanupSave") {
    t.registerComponent("agent", agent.schema, {
      ...agent.modules,
      "./component/messages.ts": async () => {
        const real = (await agent.modules["./component/messages.ts"]()) as {
          addMessages: NativeAddMessages;
        };

        return {
          ...real,
          addMessages: mutationGeneric({
            args: real.addMessages._args as never,
            returns: real.addMessages._returns as never,
            handler: async (ctx, args) => {
              const nativeArgs = args as unknown as AddMessagesArgs;

              const saved = await real.addMessages._handler(
                ctx as unknown as MutationCtx,
                nativeArgs,
              );

              if (
                state.cleanupFails &&
                nativeArgs.messages.some(({ message }) => message.role === "tool")
              )
                throw new Error("injected cleanup save failure");

              return saved as never;
            },
          }),
        };
      },
    });
  } else if (fault === "notificationSave") {
    t.registerComponent("agent", agent.schema, {
      ...agent.modules,
      "./component/messages.ts": async () => {
        const real = (await agent.modules["./component/messages.ts"]()) as {
          addMessages: NativeAddMessages;
        };

        return { ...real, addMessages: notificationSaveFault(real.addMessages) };
      },
    });
  } else if (fault === "transcriptReads") {
    t.registerComponent("agent", agent.schema, {
      ...agent.modules,
      "./component/messages.ts": async () => {
        const real = (await agent.modules["./component/messages.ts"]()) as Record<
          string,
          NativeAddMessages
        >;

        const wrapped = Object.fromEntries(
          ["getMessagesByIds", "listMessagesByThreadId"].map((name) => [
            name,
            queryGeneric({
              args: real[name]._args as never,
              returns: real[name]._returns as never,
              handler: async (ctx, args) => {
                state.transcriptReads++;

                if (state.forbidTranscriptReads) throw new Error("TRANSCRIPT_READ_FORBIDDEN");

                return (await real[name]._handler(
                  ctx as unknown as MutationCtx,
                  args as AddMessagesArgs,
                )) as never;
              },
            }),
          ]),
        );

        return { ...real, ...wrapped };
      },
    });
  } else agent.register(t);

  // Each blanket fault replaces one registered function in the module that
  // defines it; each conditional fault wraps one instead.
  const blanketFault = (
    {
      accept: { module: "./component/turns/send.ts", name: "accept" },
      finish: { module: "./component/turns/slices.ts", name: "finish" },
      attach: { module: "./component/subagents/launch.ts", name: "attach" },
      deliver: { module: "./component/subagents/deliver.ts", name: "deliver" },
      settle: { module: "./component/subagents/settle.ts", name: "settle" },
    } as const
  )[fault as "accept" | "finish" | "attach" | "deliver" | "settle"];

  const conditionalFault =
    fault === "childFinish"
      ? { module: "./component/turns/slices.ts", name: "finish" as const }
      : fault === "acceptedDelivery"
        ? { module: "./component/subagents/deliver.ts", name: "deliver" as const }
        : undefined;

  if (blanketFault || conditionalFault) {
    // A conditional fault wraps one real component mutation instead of replacing
    // it, so every other call on the same path stays real.
    const conditionalOverride = conditionalFault
      ? {
          [conditionalFault.module]: async () => {
            const real = (await agevex.modules[conditionalFault.module]()) as Record<
              string,
              AgevexMutation
            >;

            const wrap =
              conditionalFault.name === "finish" ? childFinishFault : acceptedDeliveryFault;

            return { ...real, [conditionalFault.name]: wrap(real[conditionalFault.name]) };
          },
        }
      : {};

    const blanketOverride = blanketFault
      ? {
          [blanketFault.module]: async () => ({
            ...((await agevex.modules[blanketFault.module]()) as Record<string, unknown>),
            [blanketFault.name]: failure,
          }),
        }
      : {};

    t.registerComponent("agevex", agevex.schema, {
      ...agevex.modules,
      ...conditionalOverride,
      ...blanketOverride,
    });

    // Preserve the real nested bridge even for failure injection.
    registerWorkflow(t, "agevex/rootWorkflow");
    registerWorkflow(t, "agevex/childWorkflow");
  } else agevex.register(t);

  if (fault === "lostPing" || fault === "delayedWait") {
    t.registerComponent("agevex/rootWorkflow", workflow.schema, {
      ...workflow.modules,
      "./component/agevexJournal.ts": () => import("../src/testing/journal.js"),
      ...(fault === "delayedWait"
        ? {
            "./component/pool.ts": async () => {
              const real = (await workflow.modules["./component/pool.ts"]()) as Record<
                string,
                NativeAddMessages
              >;

              return {
                ...real,
                onComplete: mutationGeneric({
                  args: real.onComplete._args as never,
                  returns: real.onComplete._returns as never,
                  handler: async (ctx, args) => {
                    const completion = args as {
                      context: { stepId: GenericId<"steps">; delayed?: boolean };
                      result: { kind: string; returnValue?: unknown };
                    };

                    const entry = await ctx.db.get(completion.context.stepId);

                    if (
                      !completion.context.delayed &&
                      entry?.step.name === "turns/loop:next" &&
                      completion.result.kind === "success" &&
                      completion.result.returnValue === null
                    ) {
                      // Delay the real completion callback, after next committed
                      // loopWaiting but before Workflow can register awaitEvent.
                      await ctx.scheduler.runAfter(
                        45_000,
                        makeFunctionReference<"mutation">("pool:onComplete"),
                        { ...completion, context: { ...completion.context, delayed: true } },
                      );

                      return null as never;
                    }

                    return (await real.onComplete._handler(
                      ctx as unknown as MutationCtx,
                      args as AddMessagesArgs,
                    )) as never;
                  },
                }),
              };
            },
          }
        : {}),
      "./component/event.ts": async () => {
        const real = (await workflow.modules["./component/event.ts"]()) as Record<
          string,
          NativeAddMessages
        >;

        return {
          ...real,
          send: mutationGeneric({
            args: real.send._args as never,
            returns: real.send._returns as never,
            handler: async (ctx, args) => {
              if (state.dropPing && (args as { name?: string }).name === "ping") {
                state.dropPing = false;

                // Model a lost doorbell without disturbing the existing awaited event.
                const id = await ctx.db.insert("events", {
                  workflowId: (args as { workflowId: string }).workflowId,
                  name: "ping",
                  state: { kind: "created" },
                });

                await ctx.db.delete(id);

                return id as never;
              }

              return (await real.send._handler(
                ctx as unknown as MutationCtx,
                args as AddMessagesArgs,
              )) as never;
            },
          }),
        };
      },
    });
  }

  return t;
}
export { api, internal, components, rawAssignment } from "./fixture/api.js";
export { state };
