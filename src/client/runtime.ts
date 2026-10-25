import {
  createFunctionHandle,
  getFunctionAddress,
  internalActionGeneric,
  type RegisteredAction,
} from "convex/server";
import { ConvexError, v } from "convex/values";
import { opaqueKey } from "./keys.js";
import { boundedDownload } from "./download.js";
import { tool } from "ai";
import { z } from "zod";
import type { ComponentApi } from "../component/_generated/component.js";
import { LIMITS } from "../component/limits.js";
import { bindOnceTool } from "./once.js";
import { bindTaskContext, runTask, type Task, type TaskOptions } from "./tasks.js";
import { scopedMeter, type SlotFacts } from "./slots.js";
import type {
  HookResult,
  HookContext,
  Activity,
  Registration,
  RunErrorCode,
  TurnArgs,
} from "./types.js";
import { authorizedEndpoints } from "./endpoints.js";
import { buildCoordinate } from "./coordinate/coordinator.js";
import { deliverTerminalRun } from "./coordinate/delivery.js";
import {
  fileAttached,
  registerFile,
  type FileAttachedArgs,
  type RegisterFileArgs,
} from "./host/files.js";
import { note, sandboxComplete, type SandboxCompletion } from "./host/notes.js";
import type { NoteArgs } from "./hooks.js";
import {
  createRuntimeContext,
  observe,
  type CoordinatorCtx,
  type RunnerCtx,
} from "./registration/context.js";
import {
  ASK_PARENT_TOOL_NAME,
  DELEGATE_TOOL_NAME,
  MESSAGE_CHILD_TOOL_NAME,
  RESERVED_TOOL_NAMES,
} from "./tool-names.js";

export { ASK_PARENT_TOOL_NAME, DELEGATE_TOOL_NAME, MESSAGE_CHILD_TOOL_NAME };
export type { SandboxCompletion };

function mergeSlotTools(...bags: import("ai").ToolSet[]): import("ai").ToolSet {
  const merged: import("ai").ToolSet = {};
  for (const bag of bags)
    for (const [name, value] of Object.entries(bag)) {
      if (name in merged || RESERVED_TOOL_NAMES.includes(name))
        throw new Error("SLOT_TOOL_COLLISION");
      merged[name] = value;
    }
  return merged;
}
function telemetryIntegrations(config: Registration, facts: SlotFacts, turnKey: string) {
  try {
    return [config.telemetry!.integration({ ...facts, turnKey })];
  } catch {
    return [];
  }
}

/**
 * Register one managed, bounded agent graph with the Agevex Convex runtime.
 *
 * The agent instances define native behavior; registration connects their graph
 * to the component, dispatch references, and host authorization policy. Direct
 * native methods remain unmanaged.
 */
export function registerAgent(component: ComponentApi, config: Registration) {
  const rt = createRuntimeContext(component, config);
  const { limits, graph, agentIndexes } = rt;
  return {
    runTask: <Input, Output>(
      ctx: RunnerCtx,
      task: Task<Input, Output>,
      input: Input,
      options: TaskOptions = {},
    ) => runTask(ctx, task, input, { ...options, component, usage: config.usage ?? options.usage }),
    registerFile: (ctx: CoordinatorCtx, args: RegisterFileArgs) => registerFile(rt, ctx, args),
    fileAttached: (ctx: Pick<RunnerCtx, "runQuery">, args: FileAttachedArgs) =>
      fileAttached(rt, ctx, args),
    sandboxComplete: (ctx: CoordinatorCtx, event: SandboxCompletion) =>
      sandboxComplete(rt, ctx, event),
    note: (ctx: CoordinatorCtx, args: NoteArgs): Promise<boolean> => note(rt, ctx, args),
    authorizedEndpoints: () => authorizedEndpoints(component, config),
    internalFunctions: () => {
      const coordinate = buildCoordinate(rt);
      const runTurn: RegisteredAction<"internal", TurnArgs, null> = internalActionGeneric({
        args: { assignmentId: v.string(), turnToken: v.string(), sliceId: v.optional(v.string()) },
        returns: v.null(),
        handler: async (ctx, args) => {
          const queued = await ctx.runQuery(component.queue.execution, {
            assignmentId: args.assignmentId,
          });
          if (!queued || queued.cancelled || queued.turnToken !== args.turnToken) return null;
          const managed = graph.byName.get(queued.agent);
          if (!managed) throw new Error("UNKNOWN_AGENT");
          // Agent 0.7.7 auto-denies unresolved approvals at generation start.
          // Only our recorded request can block a managed turn. Native history
          // is never searched to discover requests.
          if (queued.approvalBlocked) return null;
          const claimed = await ctx.runMutation(component.queue.claim, {
            ...args,
            agentIndex: agentIndexes.get(queued.agent),
            routeModel: !!managed.hooks?.beforeTurn,
            notes: {
              getMessages: await createFunctionHandle(managed.component.messages.getMessagesByIds),
              addMessages: await createFunctionHandle(managed.component.messages.addMessages),
              updateMessage: await createFunctionHandle(managed.component.messages.updateMessage),
            },
          });
          if (!claimed) return null;
          const child = claimed.subagent;
          const turnKey = await opaqueKey("turn", args.sliceId ?? args.turnToken);
          const facts: SlotFacts = {
            subject: claimed.subject,
            rootThreadId: child?.rootThreadId ?? claimed.threadId,
            threadId: claimed.threadId,
            runId: claimed.runId,
            agent: claimed.agent,
          };
          try {
            await observe(rt, ctx, {
              type: "turn.claimed",
              assignmentId: claimed.assignmentId,
              threadId: claimed.threadId,
              agent: claimed.agent,
              turnOrigin: claimed.turnOrigin,
            });
            let errorCode: Activity["errorCode"] = null;
            try {
              await config.authorizeExecution(ctx, {
                subject: claimed.subject,
                agent: claimed.agent,
                assignmentId: claimed.assignmentId,
                threadId: claimed.threadId,
                turnOrigin: claimed.turnOrigin,
                child: child
                  ? {
                      rootAssignmentId: child.rootAssignmentId,
                      rootThreadId: child.rootThreadId,
                      rootAgent: child.rootAgent,
                      runId: child.runId,
                      actorAgent: child.actorAgent,
                      childAgent: child.agent,
                    }
                  : undefined,
              });
            } catch {
              errorCode = "AUTHORIZATION_DENIED";
            }

            if (!errorCode && config.budget) {
              try {
                const budget = await config.budget.check(ctx, {
                  subject: facts.subject,
                  runId: facts.runId,
                });
                if (!budget.allowed) {
                  errorCode = "BUDGET_EXCEEDED";
                  await ctx.runMutation(component.queue.write, {
                    assignmentId: claimed.assignmentId,
                    executionId: args.turnToken,
                    cancellationEpoch: claimed.cancellationEpoch,
                    handle: await createFunctionHandle(component.hooks.addNote),
                    rejectStale: true,
                    args: {
                      assignmentId: claimed.assignmentId,
                      // Model-facing: a delegated child sees this at its next safe
                      // claim (e.g. when descendant results arrive). Raising the
                      // budget is a host decision outside the model's tools.
                      text: "BUDGET_EXCEEDED: this run reached its spending budget and its last turn stopped before another model call. Finish with what you have; more spending needs the host's approval.",
                      from: "budget",
                    },
                  });
                }
              } catch {
                errorCode = "BUDGET_EXCEEDED";
              }
              // Admission failure (including a full pending-note cap) preserves
              // the typed denial. Admitted notes wait for the next safe turn
              // claim; a slice boundary cannot deliver them between tool calls.
            }
            let childError: RunErrorCode = errorCode;
            let childResultMessageId: string | undefined;
            if (!errorCode) {
              const controller = new AbortController();
              let fencedOut = false;
              const timer = setTimeout(() => controller.abort(), LIMITS.generationAbortMs);
              const poll = setInterval(() => {
                void ctx
                  .runQuery(component.queue.execution, { assignmentId: args.assignmentId })
                  .then((row) => {
                    if (
                      !row ||
                      row.cancelled ||
                      row.turnToken !== args.turnToken ||
                      row.cancellationEpoch !== claimed.cancellationEpoch ||
                      row.turnStatus !== "running"
                    ) {
                      fencedOut = true;
                      controller.abort();
                    }
                  })
                  .catch(() => {
                    fencedOut = true;
                    controller.abort();
                  });
              }, LIMITS.cancelPollMs);
              // Route native saves and tool mutations through one atomic check.
              // Polling aborts cooperative providers; this fence also catches an
              // uncooperative provider that returns after cancellation.
              const nativeCtx: RunnerCtx = {
                ...ctx,
                runMutation: (async (
                  ref: Parameters<RunnerCtx["runMutation"]>[0],
                  payload: unknown,
                ) => {
                  // An abort listener may only close its own recorded placeholder.
                  // queue.write verifies the exact handle, id, execution and epoch.
                  if (
                    fencedOut &&
                    JSON.stringify(getFunctionAddress(ref)) !==
                      JSON.stringify(getFunctionAddress(managed.component.messages.finalizeMessage))
                  )
                    return null;
                  return ctx.runMutation(component.queue.write, {
                    assignmentId: args.assignmentId,
                    executionId: args.turnToken,
                    cancellationEpoch: claimed.cancellationEpoch,
                    handle: await createFunctionHandle(ref),
                    args: payload,
                  });
                }) as RunnerCtx["runMutation"],
              };
              const assertActive = async () => {
                const row = await ctx.runQuery(component.queue.execution, {
                  assignmentId: args.assignmentId,
                });
                if (
                  controller.signal.aborted ||
                  !row ||
                  row.cancelled ||
                  row.turnToken !== args.turnToken ||
                  row.cancellationEpoch !== claimed.cancellationEpoch ||
                  row.turnStatus !== "running"
                ) {
                  fencedOut = true;
                  controller.abort();
                  throw new ConvexError({ code: "CANCELLED" });
                }
              };
              // after cancel, the SDK refuses new nested calls and drops its own
              // writes; writes your own code makes inside an already-running nested
              // action are yours to guard with tc.signal. An action call cannot be
              // made atomic with the cancel mutation: this is admission fencing,
              // while SDK-owned/native writes retain the transactional write fence.
              // Agent 0.7.7 fires these void saves from asynchronous abort listeners.
              // They must resolve after cancellation to avoid an unhandled rejection;
              // queue.write permits only their own terminal close after the fence. All other
              // native operations, including createTool's injected ctx, reject new
              // nested calls after revocation just like defineOnceTool does.
              const nativeFinalizers = new Set(
                [managed.component.messages.finalizeMessage, managed.component.streams.abort].map(
                  (ref) => JSON.stringify(getFunctionAddress(ref)),
                ),
              );
              const fencedCtx: RunnerCtx = {
                ...nativeCtx,
                runAction: (async (ref, ...payload) => {
                  await assertActive();
                  return ctx.runAction(ref, ...payload);
                }) as RunnerCtx["runAction"],
                runMutation: (async (ref, payload) => {
                  if (nativeFinalizers.has(JSON.stringify(getFunctionAddress(ref))))
                    return nativeCtx.runMutation(ref, payload);
                  await assertActive();
                  try {
                    const saved = await ctx.runMutation(component.queue.write, {
                      assignmentId: args.assignmentId,
                      executionId: args.turnToken,
                      cancellationEpoch: claimed.cancellationEpoch,
                      handle: await createFunctionHandle(ref),
                      args: payload,
                      rejectStale: true,
                      ...(JSON.stringify(getFunctionAddress(ref)) ===
                      JSON.stringify(getFunctionAddress(managed.component.streams.create))
                        ? {
                            nativeStream: await createFunctionHandle(
                              managed.component.streams.abort,
                            ),
                          }
                        : {}),
                      ...(JSON.stringify(getFunctionAddress(ref)) ===
                      JSON.stringify(getFunctionAddress(managed.component.messages.addMessages))
                        ? {
                            // Tools without execute are native deferred calls (Agent
                            // 0.7.7 example/convex/chat/human.ts:125-157). Supply
                            // names only at the native-save seam; no transcript scan.
                            trackUsage: !!config.usage,
                            deferredTools: Object.entries(managed.declaredTools)
                              .filter(([, tool]) => !tool.execute && tool.type !== "provider")
                              .map(([name]) => name),
                            nativeMessages: {
                              getMessages: await createFunctionHandle(
                                managed.component.messages.getMessagesByIds,
                              ),
                              finalizeMessage: await createFunctionHandle(
                                managed.component.messages.finalizeMessage,
                              ),
                            },
                          }
                        : {}),
                    });
                    if (
                      config.usage &&
                      JSON.stringify(getFunctionAddress(ref)) ===
                        JSON.stringify(getFunctionAddress(managed.component.messages.addMessages))
                    ) {
                      // Agent 0.7.7 start.ts:382-417 saves step usage with its
                      // native result. queue.write captures the exact returned ids
                      // in the same transaction; no transcript discovery is needed.
                      const messages =
                        (saved as { messages?: import("@convex-dev/agent").MessageDoc[] } | null)
                          ?.messages ?? [];
                      const step = messages.find(
                        (message) => message.usage && message.status === "success",
                      );
                      const captured = step
                        ? await ctx.runQuery(component.queue.execution, {
                            assignmentId: claimed.assignmentId,
                          })
                        : null;
                      for (const message of step &&
                      captured?.modelStep?.messageId === String(step._id) &&
                      captured.modelStep.stepOrder === step.stepOrder
                        ? [step]
                        : []) {
                        if (!message.usage || message.status !== "success") continue;
                        try {
                          await config.usage
                            .scope(ctx, {
                              ...facts,
                              ...(message.model ? { model: message.model } : {}),
                            })
                            .record(message.provider ?? "model", {
                              key: await opaqueKey(
                                "model",
                                facts.threadId,
                                message._id,
                                message.stepOrder,
                              ),
                              usage: message.usage,
                              providerMetadata: message.providerMetadata,
                            });
                        } catch {
                          // Billing evidence is best effort. Never replay a paid
                          // generation because its meter was unavailable.
                        }
                      }
                    }
                    return saved;
                  } catch (error) {
                    if (error instanceof ConvexError && error.data?.code === "CANCELLED")
                      controller.abort();
                    throw error;
                  }
                }) as RunnerCtx["runMutation"],
              };
              bindTaskContext(fencedCtx, {
                component,
                attribution: facts,
                turnKey,
                usage: config.usage,
                fence: {
                  assignmentId: args.assignmentId,
                  executionId: args.turnToken,
                  cancellationEpoch: claimed.cancellationEpoch,
                },
              });
              let backend: import("./slots.js").MeterBackend | undefined;
              try {
                backend = config.usage?.scope(fencedCtx, facts);
              } catch {
                /* Usage is fail-open. */
              }
              let hookFailed = false;
              let hookBlocked = false;
              const hc: HookContext = {
                ctx: fencedCtx,
                ...facts,
                signal: controller.signal,
                meter: scopedMeter(backend, `${args.sliceId ?? args.turnToken}:hook`),
              };
              const hook = async (
                invoke: (() => HookResult | Promise<HookResult>) | undefined,
                allowModel = false,
              ): Promise<HookResult> => {
                try {
                  const result = await invoke?.();
                  for (const [key, max] of [
                    ["note", LIMITS.noteLength],
                    ["block", limits.taskLength],
                    ["continue", LIMITS.messageLength],
                    ["model", LIMITS.modelIdLength],
                  ] as const) {
                    const value = result?.[key];
                    if (
                      value !== undefined &&
                      (typeof value !== "string" || !value.trim() || value.length > max)
                    )
                      throw new Error(`INVALID_HOOK_${key.toUpperCase()}`);
                  }
                  if (
                    result?.model !== undefined &&
                    (!allowModel || !claimed.isTurnStart || !claimed.isRunStart)
                  )
                    throw new Error("MODEL_ONLY_AT_RUN_START");
                  if (result?.note)
                    await fencedCtx.runMutation(
                      allowModel ? component.hooks.beforeTurnNote : component.hooks.addNote,
                      {
                        assignmentId: claimed.assignmentId,
                        text: result.note,
                        from: managed.name,
                        ...(allowModel
                          ? {
                              addMessages: await createFunctionHandle(
                                managed.component.messages.addMessages,
                              ),
                              getMessages: await createFunctionHandle(
                                managed.component.messages.getMessagesByIds,
                              ),
                            }
                          : {}),
                      },
                    );
                  return result;
                } catch {
                  // The hook's own error is never persisted: nothing reads it and
                  // it may carry private details. The turn reports HOOK_FAILED.
                  hookFailed = true;
                  controller.abort();
                  throw new Error("HOOK_FAILED");
                }
              };
              try {
                if (config.extract && claimed.isTurnStart) {
                  const files = await fencedCtx.runQuery(component.files.forMessage, {
                    messageId: claimed.promptMessageId,
                    subject: claimed.subject,
                    threadId: claimed.threadId,
                    native: await createFunctionHandle(managed.component.files.get),
                  });
                  // Admission is the extract module's durable, deduplicated run;
                  // core never retries extraction or reads its component state.
                  for (const fileId of files)
                    await config.extract.run(fencedCtx, {
                      fileId,
                      threadId: claimed.threadId,
                      subject: claimed.subject,
                    });
                }
                let selectedModel = claimed.modelId;
                if (claimed.isTurnStart && managed.hooks?.beforeTurn) {
                  const docs = await ctx.runQuery(managed.component.messages.getMessagesByIds, {
                    messageIds: [claimed.logicalPromptMessageId],
                  });
                  const before = await hook(
                    () =>
                      managed.hooks!.beforeTurn!(hc, {
                        prompt: docs[0]?.text ?? "",
                        isRunStart: claimed.isRunStart,
                      }),
                    true,
                  );
                  if (before?.model) {
                    await hook(async () => {
                      if (!config.models || !config.modelAllowlist?.includes(before.model!))
                        throw new Error("MODEL_NOT_ALLOWED");
                      await fencedCtx.runMutation(component.hooks.hookState, {
                        assignmentId: claimed.assignmentId,
                        executionId: args.turnToken,
                        model: before.model,
                      });
                    });
                    selectedModel = before.model;
                  }
                  if (before?.block) {
                    hookBlocked = true;
                    throw new Error("HOOK_BLOCKED");
                  }
                }
                if (managed.hooks?.beforeTurn) {
                  if (claimed.isRunStart)
                    await ctx.runMutation(component.hooks.completeRouting, {
                      assignmentId: claimed.assignmentId,
                      executionId: args.turnToken,
                      agentIndex: agentIndexes.get(claimed.agent)!,
                    });
                  let routing = await ctx.runQuery(component.hooks.routing, {
                    assignmentId: claimed.assignmentId,
                    agentIndex: agentIndexes.get(claimed.agent)!,
                  });
                  // Siblings share one agent model for this request. Waiting here
                  // spends no paid model work and creates no Workflow steps; the
                  // first slice owns the decision, never a second classifier call.
                  while (routing?.pending) {
                    await new Promise((resolve) => setTimeout(resolve, LIMITS.cancelPollMs));
                    await assertActive();
                    routing = await ctx.runQuery(component.hooks.routing, {
                      assignmentId: claimed.assignmentId,
                      agentIndex: agentIndexes.get(claimed.agent)!,
                    });
                  }
                  selectedModel = routing?.modelId ?? selectedModel;
                }
                const eligible = (graph.edges.get(claimed.agent)?.size ?? 0) > 0;
                const tools = Object.fromEntries(
                  Object.entries(
                    mergeSlotTools(
                      managed.declaredTools,
                      ...(managed.sandbox && config.sandbox
                        ? [
                            config.sandbox.tools({
                              ...hc,
                              toolCallId: await opaqueKey(
                                "slot-call",
                                facts.runId,
                                args.sliceId ?? args.turnToken,
                              ),
                            }),
                          ]
                        : []),
                      ...(config.extract
                        ? [
                            config.extract.tools({
                              ...hc,
                              toolCallId: await opaqueKey(
                                "slot-call",
                                facts.runId,
                                args.sliceId ?? args.turnToken,
                              ),
                            }),
                          ]
                        : []),
                    ),
                  ).map(([name, declared]) => [
                    name,
                    bindOnceTool(
                      declared,
                      component,
                      ctx,
                      hc,
                      {
                        assignmentId: args.assignmentId,
                        executionId: args.turnToken,
                        cancellationEpoch: claimed.cancellationEpoch,
                      },
                      limits.leaseMs,
                      backend,
                    ),
                  ]),
                );
                // Agent 0.7.7 createTool.ts:315-329 and wrapTools:378-397
                // inject context through dynamic `this`; preserve that receiver.
                // SDK collaboration tools are installed AFTER this wrapper. Their
                // capability protocols must not be rewritten by generic tool hooks;
                // delegation has its own beforeDelegate interception point.
                for (const [name, declared] of Object.entries(tools)) {
                  const execute = declared.execute;
                  if (!execute) continue; // Deferred/provider-owned effects execute outside this action.
                  tools[name] = {
                    ...declared,
                    execute: async function (input, options) {
                      const before = await hook(
                        managed.hooks?.beforeTool
                          ? () => managed.hooks!.beforeTool!(hc, { tool: name, input })
                          : undefined,
                      );
                      if (before?.block)
                        return { status: "denied", code: "HOOK_BLOCKED", reason: before.block };
                      const actual = before && "input" in before ? before.input : input;
                      const callKey = await opaqueKey(
                        "tool-call",
                        facts.runId,
                        facts.threadId,
                        options.toolCallId,
                      );
                      const tc = {
                        ...hc,
                        toolCallId: callKey,
                        nativeToolCallId: options.toolCallId,
                        meter: scopedMeter(backend, callKey),
                      };
                      // Plain AI tools receive options.context; native createTool
                      // receives its normal action context plus the managed facts.
                      // Preserve native dynamic `this` injection (createTool.ts:315).
                      const receiver = {
                        ...this,
                        ctx: { ...(this as { ctx?: object }).ctx, ...fencedCtx, ...tc },
                      };
                      const output = await execute.call(receiver, actual, {
                        ...options,
                        toolCallId: callKey,
                        context: tc,
                      });
                      const reshape = async (output: unknown) => {
                        const after = await hook(
                          managed.hooks?.afterTool
                            ? () =>
                                managed.hooks!.afterTool!(hc, { tool: name, input: actual, output })
                            : undefined,
                        );
                        return after && "output" in after ? after.output : output;
                      };
                      if (output && typeof output === "object" && Symbol.asyncIterator in output) {
                        // Preserve native streaming/backpressure; every published
                        // value passes redaction before the model can consume it.
                        return (async function* () {
                          for await (const value of output) yield await reshape(value);
                        })();
                      }
                      return reshape(output);
                    },
                  };
                }
                let delegated = false;
                let asked = false;
                if (eligible)
                  tools[DELEGATE_TOOL_NAME] = tool({
                    description:
                      "Delegate one bounded task to a registered child agent. Its result arrives later. A result continuation may delegate again within the same run budget.",
                    inputSchema: z.object({
                      agent: z.string(),
                      task: z.string(),
                      group: z.string().max(LIMITS.groupLength).optional(),
                      wait: z.enum(["each", "all"]).optional(),
                    }),
                    execute: async (input, options) => {
                      const before = await hook(
                        managed.hooks?.beforeDelegate
                          ? () =>
                              managed.hooks!.beforeDelegate!(hc, {
                                agent: input.agent,
                                task: input.task,
                              })
                          : undefined,
                      );
                      if (before?.block)
                        return { status: "denied", code: "HOOK_BLOCKED", reason: before.block };
                      const rewritten =
                        before && "input" in before
                          ? await z
                              .object({
                                agent: z.string(),
                                task: z.string(),
                                group: z.string().max(LIMITS.groupLength).optional(),
                                wait: z.enum(["each", "all"]).optional(),
                              })
                              .parseAsync(before.input)
                          : input;
                      const launch = await fencedCtx.runMutation(coordinateReference(), {
                        op: "launch",
                        assignmentId: args.assignmentId,
                        turnToken: args.turnToken,
                        toolCallId: options.toolCallId,
                        agent: rewritten.agent,
                        task: rewritten.task,
                        group: rewritten.group,
                        wait: rewritten.wait,
                      });
                      if (launch?.status === "queued") delegated = true;
                      return launch;
                    },
                  });
                if (eligible)
                  tools[MESSAGE_CHILD_TOOL_NAME] = tool({
                    description:
                      "Send a bounded follow-up or answer to a child run in this root. Finished runs refuse messages.",
                    inputSchema: z.object({
                      runId: z.string(),
                      text: z.string().max(limits.taskLength),
                    }),
                    execute: (input) =>
                      fencedCtx.runMutation(coordinateReference(), {
                        op: "message",
                        assignmentId: args.assignmentId,
                        turnToken: args.turnToken,
                        ...input,
                      }),
                  });
                if (child)
                  tools[ASK_PARENT_TOOL_NAME] = tool({
                    description:
                      "Ask your parent one question and pause until it answers with message_child. Only one question may be open.",
                    inputSchema: z.object({ question: z.string().max(limits.taskLength) }),
                    execute: async (input) => {
                      const response = await fencedCtx.runMutation(coordinateReference(), {
                        op: "ask",
                        assignmentId: args.assignmentId,
                        turnToken: args.turnToken,
                        ...input,
                      });
                      if (response?.status === "accepted") asked = true;
                      return response;
                    },
                  });
                const result = await managed.streamText(
                  fencedCtx,
                  { threadId: claimed.threadId },
                  {
                    promptMessageId: claimed.promptMessageId,
                    // Agent 0.7.7 vercel/client/start.ts:107-108,234 supports this
                    // per-call override natively; never mutate a shared Agent's options.
                    ...(selectedModel
                      ? {
                          model: (() => {
                            if (!config.models || !config.modelAllowlist?.includes(selectedModel))
                              throw new Error("MODEL_NOT_ALLOWED");
                            return config.models(selectedModel);
                          })(),
                        }
                      : {}),
                    tools,
                    ...(config.telemetry
                      ? {
                          telemetry: {
                            integrations: telemetryIntegrations(config, facts, turnKey),
                          },
                        }
                      : {}),
                    experimental_download: boundedDownload(
                      queued.attachmentBytes,
                      controller.signal,
                    ),
                    maxOutputTokens: LIMITS.outputTokens,
                    maxRetries: LIMITS.modelRetries,
                    // Native stop conditions are evaluated after each step: exactly
                    // one model step per slice.
                    stopWhen: () => true,
                    abortSignal: controller.signal,
                  },
                  {
                    saveStreamDeltas: { chunking: "word", throttleMs: LIMITS.streamThrottleMs },
                    storageOptions: { saveMessages: "promptAndOutput" },
                  },
                );
                let streamError = false;
                await result.consumeStream({
                  onError: () => {
                    streamError = true;
                  },
                });
                const reason = await result.finishReason;
                const accepted = ["stop", "length", "tool-calls"];
                if (
                  hookFailed ||
                  streamError ||
                  controller.signal.aborted ||
                  !accepted.includes(reason)
                )
                  throw new Error("INCOMPLETE_GENERATION");
                const snapshot = await ctx.runQuery(component.queue.execution, {
                  assignmentId: args.assignmentId,
                });
                if (
                  !snapshot ||
                  snapshot.cancelled ||
                  snapshot.turnToken !== args.turnToken ||
                  snapshot.cancellationEpoch !== claimed.cancellationEpoch
                )
                  return null;
                if (child && asked) {
                  await fencedCtx.runMutation(component.queue.finish, {
                    assignmentId: args.assignmentId,
                    turnToken: args.turnToken,
                    errorCode: null,
                  });
                  return null;
                }
                if (reason === "tool-calls" && !delegated) {
                  const last = result.savedMessages?.[result.savedMessages.length - 1];
                  if (last) {
                    await ctx.runMutation(component.queue.continueTurn, {
                      assignmentId: args.assignmentId,
                      executionId: args.turnToken,
                      cancellationEpoch: claimed.cancellationEpoch,
                      messageId: String(last._id),
                    });
                    return null;
                  }
                }
                const completedTurn = await fencedCtx.runMutation(component.hooks.hookState, {
                  assignmentId: claimed.assignmentId,
                  executionId: args.turnToken,
                  complete: true,
                });
                const savedText = (result.savedMessages ?? [])
                  .filter(
                    (message) =>
                      message.message?.role === "assistant" && message.status === "success",
                  )
                  .map((message) => message.text ?? "")
                  .join("\n");
                const after = await hook(
                  managed.hooks?.afterTurn
                    ? () => managed.hooks!.afterTurn!(hc, { turn: completedTurn, text: savedText })
                    : undefined,
                );
                // A side review is best effort, independently admitted and never
                // awaited as a workflow/child result. Only its short launch mutation
                // is awaited here; paid child work is dispatched on the child lane.
                for (const side of managed.sideAgents ?? []) {
                  try {
                    await fencedCtx.runMutation(coordinateReference(), {
                      op: "launch",
                      side: true,
                      assignmentId: claimed.assignmentId,
                      turnToken: args.turnToken,
                      toolCallId: `side:${side.agent.name}:${completedTurn}`,
                      agent: side.agent.name,
                      task: "Review the following conversation delta. Reply with a short helpful note, or NONE if there is nothing to add.",
                    });
                  } catch {
                    /* Side review failures never fail the watched turn. */
                  }
                }
                const continuation = after?.continue
                  ? await fencedCtx.runMutation(component.hooks.continueAdmission, {
                      assignmentId: claimed.assignmentId,
                      executionId: args.turnToken,
                      prompt: after.continue,
                    })
                  : null;
                if (continuation) {
                  await fencedCtx.runMutation(component.queue.continueTurn, {
                    assignmentId: claimed.assignmentId,
                    executionId: args.turnToken,
                    cancellationEpoch: claimed.cancellationEpoch,
                    messageId: continuation,
                  });
                  return null;
                }
                if (child) {
                  // Native final saves have completed. A child result must be a
                  // saved, non-empty assistant text message; tool-only or empty
                  // output is a failed run, never a delivered result.
                  const saved = (result.savedMessages ?? []).filter(
                    (message) =>
                      message.message?.role === "assistant" && message.status === "success",
                  );
                  const final = saved[saved.length - 1];
                  if (!final?.text || !final.text.trim()) {
                    childError = "EMPTY_RESULT";
                  } else {
                    childResultMessageId = String(final._id);
                  }
                }
              } catch {
                errorCode = hookFailed ? "HOOK_FAILED" : hookBlocked ? null : "GENERATION_FAILED";
                childError = hookFailed
                  ? "HOOK_FAILED"
                  : hookBlocked
                    ? "EMPTY_RESULT"
                    : "GENERATION_FAILED";
              } finally {
                clearTimeout(timer);
                clearInterval(poll);
                if (claimed.isRunStart && managed.hooks?.beforeTurn) {
                  await ctx.runMutation(component.hooks.completeRouting, {
                    assignmentId: claimed.assignmentId,
                    executionId: args.turnToken,
                    agentIndex: agentIndexes.get(claimed.agent)!,
                  });
                }
              }
            }

            // Authorization runs before the generation try/finally. A denial
            // must settle the same routing attempt as generation/hook failures;
            // queue's terminal fences also cover actions that never return here.
            if (
              errorCode === "AUTHORIZATION_DENIED" &&
              claimed.isRunStart &&
              managed.hooks?.beforeTurn
            )
              await ctx.runMutation(component.hooks.completeRouting, {
                assignmentId: claimed.assignmentId,
                executionId: args.turnToken,
                agentIndex: agentIndexes.get(claimed.agent)!,
              });

            const current = await ctx.runQuery(component.queue.execution, {
              assignmentId: args.assignmentId,
            });
            if (
              !current ||
              current.cancelled ||
              current.turnToken !== args.turnToken ||
              current.cancellationEpoch !== claimed.cancellationEpoch
            )
              return null;
            if (!child) {
              // A root turn owns nothing but its own queue state.
              await ctx.runMutation(component.queue.finish, {
                assignmentId: args.assignmentId,
                turnToken: args.turnToken,
                errorCode,
              });
              await observe(rt, ctx, {
                type: "turn.finished",
                assignmentId: claimed.assignmentId,
                threadId: claimed.threadId,
                agent: claimed.agent,
                outcome: errorCode ? "failure" : "success",
                errorCode,
              });
              return null;
            }

            // A child turn additionally owns exactly one run. Settlement,
            // delivery and finalization are three separate transactions, so none
            // can roll back another's outcome, and the child token still owns the
            // run until `queue.finish` releases it.
            try {
              const settlement = await ctx.runMutation(coordinateReference(), {
                op: "settle",
                assignmentId: args.assignmentId,
                turnToken: args.turnToken,
                runId: child.runId,
                ...(childResultMessageId ? { resultMessageId: childResultMessageId } : {}),
                errorCode: childError,
              });
              if (settlement?.status === "deferred") {
                // This verified outcome is retained while descendants/inbox
                // fence settlement. New work replaces it on the next claim; if
                // delivery leaves no work, clearing the fence settles it as-is.
                await ctx.runMutation(component.queue.finish, {
                  assignmentId: args.assignmentId,
                  turnToken: args.turnToken,
                  errorCode: null,
                });
                return null;
              }
              await observe(rt, ctx, {
                type: "delegation.settled",
                runId: child.runId,
                rootAssignmentId: child.rootAssignmentId,
                agent: child.agent,
                outcome: childError ? "failed" : "completed",
              });
            } catch {
              // The outcome could not be recorded, so this failure propagates on
              // purpose. Finishing the turn here would clear the child token and
              // with it the only claim-armed watchdog that could still record this
              // run, stranding it active forever. `worker.dispatch` catches the
              // thrown action and calls `queue.ambiguous`, which fails the turn
              // and escalates the run exactly once; nothing replays the
              // generation.
              throw new Error("EXECUTION_AMBIGUOUS");
            }
            // Delivery is attempted here, after the outcome is committed and
            // before the turn is finalized. The child turn owns the delivery
            // capability, so finalizing first would let a `queue.finish` failure
            // skip notification permanently: the run would already be terminal,
            // `escalate` would return without scheduling anything, and the
            // watchdog ignores a recovery-required child. Ordering it first makes
            // delivery independent of the finalization outcome, and it is still
            // bounded and one-shot — `deliver` no-ops once delivery is no longer
            // `pending`, so the ambiguity path cannot replay it.
            await deliverTerminalRun(rt, ctx, child.runId, child.deliveryToken);
            await ctx.runMutation(component.queue.finish, {
              assignmentId: args.assignmentId,
              turnToken: args.turnToken,
              errorCode,
            });
            await observe(rt, ctx, {
              type: "turn.finished",
              assignmentId: claimed.assignmentId,
              threadId: claimed.threadId,
              agent: claimed.agent,
              outcome: errorCode ? "failure" : "success",
              errorCode,
            });
            return null;
          } finally {
            if (config.telemetry) {
              const controller = new AbortController();
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                // Race even uncooperative exporters; abort alone cannot bound an
                // arbitrary Promise. One action spends at most three seconds.
                await Promise.race([
                  Promise.resolve().then(() =>
                    config.telemetry!.flush({ ...facts, turnKey }, controller.signal),
                  ),
                  new Promise<void>((resolve) => {
                    timer = setTimeout(() => {
                      controller.abort();
                      resolve();
                    }, LIMITS.telemetryFlushMs);
                  }),
                ]);
              } catch {
                /* Export failures never change turn state. */
              } finally {
                clearTimeout(timer);
              }
            }
          }
        },
      });
      /**
       * Resolve the host-supplied reference to this coordinator.
       *
       * The registered builder above is what the host exports; `refs.coordinate`
       * is the reference Convex can actually invoke. Both name the same
       * function, and `refs.coordinate` is required whenever collaboration is
       * configured, so resolving it lazily keeps a Main-only registration free
       * of a coordinator entirely.
       */
      const coordinateReference = () => config.refs.coordinate!();
      return { runTurn, coordinate };
    },
  };
}
