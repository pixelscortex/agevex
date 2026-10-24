// Managed turn runtime: the single host registration, its one bounded turn
// action, its one coordinator mutation and the reserved delegation tool.
//
// Generation, tools, threads, messages and streaming stay native. What this
// module adds is Workpool-backed execution of one root or child turn at a time,
// a persisted parent result path back into the root transcript, and honest
// coordination state around both.
//
// Collaboration is depth 1 by construction. A root may delegate to its declared
// children during a caller-triggered turn; a child can never delegate, a
// result-triggered continuation can never delegate, and inherited direct native
// calls on a managed thread stay unmanaged.

import { createThread, getThreadMetadata, listMessages, saveMessage } from "@convex-dev/agent";
import {
  createFunctionHandle,
  internalActionGeneric,
  internalMutationGeneric,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type RegisteredAction,
  type RegisteredMutation,
} from "convex/server";
import { v } from "convex/values";
import { tool } from "ai";
import { z } from "zod";
import type { ComponentApi } from "../component/_generated/component.js";
import { denialCode, runErrorCode } from "../component/schema.js";
import {
  GENERATION_ABORT_MS,
  MAX_DELEGATION_TASK_LENGTH,
  MAX_OUTPUT_TOKENS,
} from "../component/limits.js";
import type {
  Activity,
  CoordinateArgs,
  CoordinateResult,
  ManagedAgent,
  Registration,
  RunErrorCode,
  AgentEvent,
  TurnArgs,
} from "./types.js";
import { authorizedEndpoints } from "./endpoints.js";

/**
 * Reserved managed tool name. It is rejected in any root's own tools at
 * registration, so merging the managed tool can never silently overwrite a host
 * tool, and a host cannot impersonate it.
 */
export const DELEGATE_TOOL_NAME = "agevex_delegate";

/** Bounded native read used to authenticate a child's final message. */
const RESULT_VERIFICATION_PAGE = 20;

/** Mutation context the coordinator runs with; also what native saves accept. */
type CoordinatorCtx = GenericMutationCtx<GenericDataModel>;

/** Action context the host runner finalizes a turn with. */
type RunnerCtx = GenericActionCtx<GenericDataModel>;

/** Trusted, server-derived delivery context; contains no capability. */
type DeliveryContext = {
  runId: string;
  agent: string;
  rootAgent: string;
  actorAgent: string;
  subject: string;
  rootAssignmentId: string;
  rootThreadId: string;
  childThreadId: string;
  childResultMessageId: string | null;
  status: "completed" | "failed";
  errorCode: RunErrorCode;
  rootAvailable: boolean;
};

/** The native facts one child-result verification is allowed to assume. */
type ChildResultTarget = {
  threadId: string;
  agentName: string;
  messageId: string;
  subject: string;
};

/** Resolved, validated delegation graph built once at registration. */
type Graph = {
  /** Every executable managed agent, roots and shared children alike. */
  byName: Map<string, ManagedAgent>;
  /** Child agent objects, keyed by the name a delegation request uses. */
  children: Map<string, ManagedAgent>;
  /** Which child names a root may delegate to. */
  edges: Map<string, ReadonlySet<string>>;
};

/** Whether a value is an executable managed agent rather than a name-only entry. */
function isManagedAgent(value: unknown): value is ManagedAgent {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as ManagedAgent).name === "string" &&
    typeof (value as ManagedAgent).streamText === "function" &&
    typeof (value as ManagedAgent).component === "object" &&
    Array.isArray((value as ManagedAgent).subagents)
  );
}

/**
 * Validate the declared agent graph and resolve every delegation target.
 *
 * Rejected explicitly rather than tolerated: an unknown or name-only subagent
 * entry, a duplicate name bound to two different agents, a cycle, depth greater
 * than 1, a child that is also a public root, and a host tool that would collide
 * with the reserved delegation tool name. A child object does not need to be
 * listed in `Registration.agents`, so a shared definition stays non-public.
 */
function resolveGraph(config: Registration): Graph {
  const byName = new Map<string, ManagedAgent>();
  const children = new Map<string, ManagedAgent>();
  const edges = new Map<string, ReadonlySet<string>>();
  for (const root of config.agents) {
    if (!root.name || !isManagedAgent(root)) throw new Error("INVALID_AGENT");
    if (byName.has(root.name)) throw new Error("DUPLICATE_AGENT_NAME");
    if (DELEGATE_TOOL_NAME in root.declaredTools) throw new Error("RESERVED_TOOL_NAME");
    byName.set(root.name, root);
  }
  const roots = new Set(byName.keys());
  for (const root of config.agents) {
    const allowed = new Set<string>();
    const seen = new Set<unknown>([root]);
    for (const child of root.subagents) {
      if (!isManagedAgent(child)) throw new Error("UNKNOWN_SUBAGENT");
      if (seen.has(child)) throw new Error("SUBAGENT_CYCLE");
      seen.add(child);
      // A public root that somebody else also declares as a child is reported as
      // exactly that, before the generic duplicate-name check, because the graph
      // cannot be resolved at all.
      if (roots.has(child.name) && byName.get(child.name) !== child)
        throw new Error("ROOT_AS_CHILD");
      const existing = byName.get(child.name) ?? children.get(child.name);
      if (existing && existing !== child) throw new Error("DUPLICATE_AGENT_NAME");
      if (child.subagents.length) throw new Error("SUBAGENT_DEPTH");
      byName.set(child.name, child);
      children.set(child.name, child);
      allowed.add(child.name);
    }
    edges.set(root.name, allowed);
  }
  return { byName, children, edges };
}

/** Stable hash of the requested delegation, used for the scoped conflict check. */
async function fingerprint(input: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Convex argument validator for the coordinator.
 *
 * Declared as one flat object with a discriminant rather than a validator union:
 * Convex requires an arguments validator to be an object, and the discriminated
 * `CoordinateArgs` union is enforced by the handler, which refuses any
 * combination the contract does not define.
 */
const coordinateArgs = v.object({
  op: v.string(),
  assignmentId: v.optional(v.string()),
  turnToken: v.optional(v.string()),
  toolCallId: v.optional(v.string()),
  agent: v.optional(v.string()),
  task: v.optional(v.string()),
  runId: v.optional(v.string()),
  resultMessageId: v.optional(v.string()),
  errorCode: v.optional(runErrorCode),
  deliveryToken: v.optional(v.string()),
});

const delegationResult = v.union(
  v.object({ status: v.literal("queued"), runId: v.string(), agent: v.string() }),
  v.object({ status: v.literal("denied"), code: denialCode }),
);

/**
 * Register one managed, bounded agent graph with the Agevex Convex runtime.
 *
 * The agent instances define native behavior; registration connects their graph
 * to the component, dispatch references, and host authorization policy. Direct
 * native methods remain unmanaged.
 */
export function registerAgent(component: ComponentApi, config: Registration) {
  const graph = resolveGraph(config);
  const collaboration = [...graph.edges.values()].some((allowed) => allowed.size > 0);
  if (collaboration && !config.refs.coordinate) throw new Error("COORDINATE_REF_REQUIRED");

  async function observe(ctx: CoordinatorCtx | RunnerCtx, event: AgentEvent): Promise<void> {
    try {
      await config.observe?.(ctx, event);
    } catch {
      // Observability is best effort and must never change managed execution.
    }
  }

  /**
   * Authenticate one child's final message against the native child transcript.
   *
   * Requires the thread to exist and still belong to the stored subject, and the
   * exact stored message id to be an `assistant` `success` message attributed to
   * the expected child agent and carry non-empty text. A caller-selected message id
   * therefore cannot settle or be delivered as a result, a tool-only or empty
   * completion is rejected, and a foreign thread is refused even when it holds a
   * message with the same id.
   *
   * The `assistant` role is what makes this a result and not merely a saved
   * message: native `saveMessage` lets a caller store a `user` message that names
   * an agent, so a user-role message on the correct child thread would otherwise
   * pass every other check and settle a run with no final assistant output. Native
   * user prompts are still stored and read normally; only result verification
   * requires the assistant role.
   *
   * Returns the verified text, or `null` when the message cannot be trusted.
   */
  async function verifyChildMessage(
    ctx: CoordinatorCtx,
    target: ChildResultTarget,
  ): Promise<string | null> {
    const child = graph.children.get(target.agentName);
    if (!child) return null;
    const thread = await getThreadMetadata(ctx, child.component, { threadId: target.threadId });
    if (!thread || thread.userId !== target.subject) return null;
    const page = await listMessages(ctx, child.component, {
      threadId: target.threadId,
      paginationOpts: { cursor: null, numItems: RESULT_VERIFICATION_PAGE },
    });
    const found = page.page.find(
      (message) =>
        String(message._id) === target.messageId &&
        message.message?.role === "assistant" &&
        message.status === "success" &&
        message.agentName === target.agentName,
    );
    if (!found) return null;
    // `text` is the native extraction of this saved message's text parts.
    const text = found.text;
    return text && text.trim() ? text : null;
  }

  /**
   * Attempt the single bounded delivery of a terminal run.
   *
   * Order is fixed by what each step is allowed to assume. Root availability is
   * checked first so an unavailable root records `blocked` **without** a native
   * write; a successful child result is then authenticated against the child
   * transcript; host delivery authorization is enforced with the current
   * background policy; only then is the parent notification saved and the
   * component queue told about it.
   *
   * Returns `null` in every case: the outcome is persisted state, never a
   * generated answer, a read receipt or a completed task.
   */
  async function attemptDelivery(
    ctx: CoordinatorCtx,
    context: DeliveryContext,
    deliveryToken: string,
  ): Promise<null> {
    const record = (
      deliveryStatus: "accepted" | "failed" | "blocked",
      code: RunErrorCode,
      parentMessageId: string | null = null,
    ) =>
      ctx.runMutation(component.subagents.deliver, {
        runId: context.runId,
        deliveryToken,
        deliveryStatus,
        parentMessageId,
        errorCode: code,
      });
    if (!context.rootAvailable) {
      await record("blocked", "ROOT_UNAVAILABLE");
      await observe(ctx, {
        type: "delegation.delivered",
        runId: context.runId,
        rootAssignmentId: context.rootAssignmentId,
        agent: context.agent,
        outcome: "blocked",
      });
      return null;
    }
    let text: string;
    if (context.status === "completed") {
      const verified = context.childResultMessageId
        ? await verifyChildMessage(ctx, {
            threadId: context.childThreadId,
            agentName: context.agent,
            messageId: context.childResultMessageId,
            subject: context.subject,
          })
        : null;
      if (!verified) {
        await record("failed", "RESULT_UNVERIFIED");
        await observe(ctx, {
          type: "delegation.delivered",
          runId: context.runId,
          rootAssignmentId: context.rootAssignmentId,
          agent: context.agent,
          outcome: "failed",
        });
        return null;
      }
      text = `${context.agent} completed the delegated task.\n\n${verified}`;
    } else {
      text = `${context.agent} failed the delegated task (${
        context.errorCode ?? "GENERATION_FAILED"
      }). No result was accepted.`;
    }
    const root = graph.byName.get(context.rootAgent);
    if (!root) {
      await record("blocked", "ROOT_UNAVAILABLE");
      await observe(ctx, {
        type: "delegation.delivered",
        runId: context.runId,
        rootAssignmentId: context.rootAssignmentId,
        agent: context.agent,
        outcome: "blocked",
      });
      return null;
    }
    let subject = "";
    try {
      ({ subject } = await config.authorize(ctx, {
        operation: "deliver",
        agent: context.rootAgent,
        threadId: context.rootThreadId,
        subject: context.subject,
        rootAssignmentId: context.rootAssignmentId,
        rootAgent: context.rootAgent,
        actorAgent: context.actorAgent,
        childAgent: context.agent,
        runId: context.runId,
      }));
    } catch {
      subject = "";
    }
    if (!subject || subject !== context.subject) {
      await record("blocked", "AUTHORIZATION_DENIED");
      await observe(ctx, {
        type: "delegation.delivered",
        runId: context.runId,
        rootAssignmentId: context.rootAssignmentId,
        agent: context.agent,
        outcome: "blocked",
      });
      return null;
    }
    const { messageId } = await saveMessage(ctx, root.component, {
      threadId: context.rootThreadId,
      prompt: text,
      userId: context.subject,
      agentName: context.agent,
    });
    await record("accepted", null, messageId);
    await observe(ctx, {
      type: "delegation.delivered",
      runId: context.runId,
      rootAssignmentId: context.rootAssignmentId,
      agent: context.agent,
      outcome: "accepted",
    });
    return null;
  }

  /**
   * Make the single bounded delivery attempt of a settled run.
   *
   * `notify` saves the native parent notification and accepts it into the
   * component queue inside one host transaction, so a throw there rolls both
   * back and leaves the run terminal but undelivered. That outcome is then
   * recorded by a separate metadata-only transition using the same one-shot
   * capability and the same pending-status compare-and-set; the delivery itself
   * is never attempted twice. If even the failure record cannot commit, the run
   * stays honestly `pending` rather than claiming an outcome that was not
   * stored.
   */
  async function deliverTerminalRun(
    ctx: RunnerCtx,
    runId: string,
    deliveryToken: string,
  ): Promise<void> {
    try {
      // `refs.coordinate` is required whenever collaboration is configured, and
      // this path is only reachable from a child turn of such a registration.
      await ctx.runMutation(config.refs.coordinate!(), { op: "notify", runId, deliveryToken });
    } catch {
      try {
        await ctx.runMutation(component.subagents.deliver, {
          runId,
          deliveryToken,
          deliveryStatus: "failed",
          parentMessageId: null,
          errorCode: "DELIVERY_FAILED",
        });
      } catch {
        // The attempt and its failure record both failed to commit; nothing is
        // claimed about a delivery that did not happen.
      }
    }
  }

  return {
    authorizedEndpoints: () => authorizedEndpoints(component, config),
    internalFunctions: () => {
      const coordinate: RegisteredMutation<"internal", CoordinateArgs, CoordinateResult> =
        internalMutationGeneric({
          args: coordinateArgs,
          returns: v.union(delegationResult, v.null()),
          /**
           * The only host entry point for managed collaboration.
           *
           * Each operation validates a capability the caller already holds
           * before any policy call or write: `launch` the actor's currently
           * running turn token plus the native tool call id, `settle` the child
           * turn token that owns the run, `notify` the one-shot delivery
           * capability minted at launch. Ownership and outcome always come from
           * persisted state and verified native messages, never from a
           * caller-supplied principal flag.
           */
          handler: async (ctx, raw) => {
            const args = raw as CoordinateArgs;
            if (args.op === "launch") {
              const task = args.task.trim();
              if (!task || task.length > MAX_DELEGATION_TASK_LENGTH)
                return { status: "denied" as const, code: "TASK_LIMIT" as const };
              const owned = await ctx.runQuery(component.subagents.delegateContext, {
                assignmentId: args.assignmentId,
                turnToken: args.turnToken,
              });
              if (!owned) return { status: "denied" as const, code: "STALE_TURN" as const };
              if (!graph.edges.get(owned.actorAgent)?.has(args.agent))
                return { status: "denied" as const, code: "FORBIDDEN" as const };
              let subject = "";
              try {
                ({ subject } = await config.authorize(ctx, {
                  operation: "delegate",
                  agent: owned.rootAgent,
                  threadId: owned.rootThreadId,
                  subject: owned.subject,
                  rootAssignmentId: owned.rootAssignmentId,
                  rootAgent: owned.rootAgent,
                  actorAgent: owned.actorAgent,
                  childAgent: args.agent,
                  task,
                }));
              } catch {
                subject = "";
              }
              if (!subject || subject !== owned.subject)
                return { status: "denied" as const, code: "FORBIDDEN" as const };
              const child = graph.children.get(args.agent);
              if (!child) return { status: "denied" as const, code: "FORBIDDEN" as const };
              const reservation = await ctx.runMutation(component.subagents.reserve, {
                assignmentId: args.assignmentId,
                turnToken: args.turnToken,
                toolCallId: args.toolCallId,
                agent: args.agent,
                payloadFingerprint: await fingerprint([owned.actorAgent, args.agent, task]),
                coordinateHandle: await createFunctionHandle(config.refs.coordinate!()),
                runTurn: await createFunctionHandle(config.refs.runTurn()),
              });
              if (reservation.kind === "denied") {
                return { status: "denied" as const, code: reservation.code };
              }
              if (reservation.kind === "replay")
                return { status: "queued" as const, runId: reservation.runId, agent: args.agent };
              // Only a fresh reservation reaches the native writes, so a replay
              // can never create a second child thread. Everything below runs in
              // this same transaction as `reserve`.
              const threadId = await createThread(ctx, child.component, { userId: owned.subject });
              const { messageId } = await saveMessage(ctx, child.component, {
                threadId,
                prompt: task,
                userId: owned.subject,
              });
              await ctx.runMutation(component.subagents.attach, {
                runId: reservation.runId,
                childThreadId: threadId,
                promptMessageId: messageId,
              });
              await observe(ctx, {
                type: "delegation.queued",
                runId: reservation.runId,
                rootAssignmentId: owned.rootAssignmentId,
                agent: args.agent,
              });
              return { status: "queued" as const, runId: reservation.runId, agent: args.agent };
            }

            // Settling records the child's outcome only. Delivery is a separate
            // transaction so that a failed delivery can never roll back the
            // truthful child outcome or the counters it already moved.
            //
            // The reported result is authenticated against the native child
            // transcript *before* any terminal state is written, so an invalid,
            // missing, wrong-thread or wrong-agent message id settles as a
            // sanitized failure instead of a completed run.
            if (args.op === "settle") {
              const settlement = await ctx.runQuery(component.subagents.settlementContext, {
                assignmentId: args.assignmentId,
                turnToken: args.turnToken,
                runId: args.runId,
              });
              if (!settlement) throw new Error("FORBIDDEN");
              let errorCode: RunErrorCode = args.errorCode;
              let childResultMessageId: string | null = null;
              if (!errorCode) {
                const reported = args.resultMessageId;
                const verified = reported
                  ? await verifyChildMessage(ctx, {
                      threadId: settlement.childThreadId,
                      agentName: settlement.agent,
                      messageId: reported,
                      subject: settlement.subject,
                    })
                  : null;
                if (verified && reported) childResultMessageId = reported;
                else errorCode = "RESULT_UNVERIFIED";
              }
              await ctx.runMutation(component.subagents.settle, {
                assignmentId: args.assignmentId,
                turnToken: args.turnToken,
                runId: args.runId,
                childResultMessageId,
                errorCode,
              });
              return null;
            }

            const context = await ctx.runQuery(component.subagents.deliveryContext, {
              runId: args.runId,
              deliveryToken: args.deliveryToken,
            });
            if (!context) return null;
            return attemptDelivery(ctx, context, args.deliveryToken);
          },
        });

      const runTurn: RegisteredAction<"internal", TurnArgs, null> = internalActionGeneric({
        args: { assignmentId: v.string(), turnToken: v.string() },
        returns: v.null(),
        handler: async (ctx, args) => {
          const claimed = await ctx.runMutation(component.queue.claim, args);
          if (!claimed) return null;
          const child = claimed.subagent;
          await observe(ctx, {
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

          let childError: RunErrorCode = errorCode;
          let childResultMessageId: string | undefined;
          if (!errorCode) {
            const controller = new AbortController();
            const timer = setTimeout(() => controller.abort(), GENERATION_ABORT_MS);
            try {
              const managed = graph.byName.get(claimed.agent);
              if (!managed) throw new Error("UNKNOWN_AGENT");
              // The managed tool is offered only to a root's caller-triggered
              // turn, and only when that root actually declares children.
              const eligible =
                !child && claimed.turnOrigin === "user" && graph.edges.has(claimed.agent);
              const tools = eligible
                ? {
                    ...managed.declaredTools,
                    [DELEGATE_TOOL_NAME]: tool({
                      description:
                        "Delegate one bounded task to a registered child agent. Returns as soon as the child is queued; the result is delivered into this thread later.",
                      inputSchema: z.object({ agent: z.string(), task: z.string() }),
                      execute: async (input, options) =>
                        ctx.runMutation(coordinateReference(), {
                          op: "launch",
                          assignmentId: args.assignmentId,
                          turnToken: args.turnToken,
                          toolCallId: options.toolCallId,
                          agent: input.agent,
                          task: input.task,
                        }),
                    }),
                  }
                : undefined;
              const result = await managed.streamText(
                ctx,
                { threadId: claimed.threadId },
                {
                  promptMessageId: claimed.promptMessageId,
                  ...(tools ? { tools } : {}),
                  maxOutputTokens: MAX_OUTPUT_TOKENS,
                  maxRetries: 0,
                  // Native stop conditions are evaluated after each step: exactly
                  // one model step per turn.
                  stopWhen: () => true,
                  abortSignal: controller.signal,
                },
                {
                  saveStreamDeltas: { chunking: "word", throttleMs: 0 },
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
              const accepted = child ? ["stop", "length"] : ["stop", "length", "tool-calls"];
              if (streamError || controller.signal.aborted || !accepted.includes(reason))
                throw new Error("INCOMPLETE_GENERATION");
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
              errorCode = "GENERATION_FAILED";
              childError = "GENERATION_FAILED";
            } finally {
              clearTimeout(timer);
            }
          }

          if (!child) {
            // A root turn owns nothing but its own queue state.
            await ctx.runMutation(component.queue.finish, { ...args, errorCode });
            await observe(ctx, {
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
            await ctx.runMutation(coordinateReference(), {
              op: "settle",
              assignmentId: args.assignmentId,
              turnToken: args.turnToken,
              runId: child.runId,
              ...(childResultMessageId ? { resultMessageId: childResultMessageId } : {}),
              errorCode: childError,
            });
            await observe(ctx, {
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
          await deliverTerminalRun(ctx, child.runId, child.deliveryToken);
          await ctx.runMutation(component.queue.finish, { ...args, errorCode });
          await observe(ctx, {
            type: "turn.finished",
            assignmentId: claimed.assignmentId,
            threadId: claimed.threadId,
            agent: claimed.agent,
            outcome: errorCode ? "failure" : "success",
            errorCode,
          });
          return null;
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
