import { createThread, getThreadMetadata, saveMessage } from "@convex-dev/agent";
import {
  createFunctionHandle,
  getFunctionAddress,
  internalActionGeneric,
  internalMutationGeneric,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
  type RegisteredAction,
  type RegisteredMutation,
} from "convex/server";
import { ConvexError, getConvexSize, v } from "convex/values";
import { tool } from "ai";
import { z } from "zod";
import type { ComponentApi } from "../component/_generated/component.js";
import { denialCode, runErrorCode } from "../component/schema.js";
import { LIMITS, resolveLimits } from "../component/limits.js";
import { postNote, type NoteArgs } from "./hooks.js";
import { bindOnceTool, fingerprint, noopMeter } from "./once.js";
import type {
  HookResult,
  HookContext,
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
 * Reserved managed tool names. They are rejected in every agent's own tools at
 * registration, so merging the managed tool can never silently overwrite a host
 * tool, and a host cannot impersonate it.
 */
export const DELEGATE_TOOL_NAME = "agevex_delegate";
export const MESSAGE_CHILD_TOOL_NAME = "agevex_message_child";
export const ASK_PARENT_TOOL_NAME = "agevex_ask_parent";

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
  parentAgent: string;
  parentThreadId: string;
  side?: boolean;
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
 * than the host's maxDepth, a child that is also a public root, and any host
 * tool colliding with a reserved managed collaboration name. A child object does not need to be
 * listed in `Registration.agents`, so a shared definition stays non-public.
 */
function resolveGraph(config: Registration): Graph {
  const byName = new Map<string, ManagedAgent>();
  const children = new Map<string, ManagedAgent>();
  const edges = new Map<string, ReadonlySet<string>>();
  const roots = new Set(config.agents.map((root) => root.name));
  if (roots.size !== config.agents.length) throw new Error("DUPLICATE_AGENT_NAME");
  const maxDepth = resolveLimits(config.limits).maxDepth;
  function visit(agent: ManagedAgent, depth: number, path: Set<ManagedAgent>) {
    if (!isManagedAgent(agent)) throw new Error("UNKNOWN_SUBAGENT");
    if (!agent.name || agent.name.length > LIMITS.requestKeyLength)
      throw new Error("INVALID_AGENT");
    if (path.has(agent)) throw new Error("SUBAGENT_CYCLE");
    if (depth > maxDepth) throw new Error("SUBAGENT_DEPTH");
    if (depth && roots.has(agent.name)) throw new Error("ROOT_AS_CHILD");
    const existing = byName.get(agent.name);
    if (existing && existing !== agent) throw new Error("DUPLICATE_AGENT_NAME");
    if (
      [DELEGATE_TOOL_NAME, MESSAGE_CHILD_TOOL_NAME, ASK_PARENT_TOOL_NAME].some(
        (name) => name in agent.declaredTools,
      )
    )
      throw new Error("RESERVED_TOOL_NAME");
    byName.set(agent.name, agent);
    if (depth) children.set(agent.name, agent);
    edges.set(agent.name, new Set(agent.subagents.map((child) => child.name)));
    // Walk every path, even through a shared object: its longest path must fit.
    const next = new Set(path).add(agent);
    const sides = agent.sideAgents ?? [];
    if (
      sides.length > LIMITS.sideAgents ||
      new Set(sides.map((side) => side.agent.name)).size !== sides.length
    )
      throw new Error("INVALID_SIDE_AGENTS");
    for (const side of sides) {
      const values = Object.values(side.every);
      if (
        side.sees !== "delta" ||
        values.length !== 1 ||
        !Number.isSafeInteger(values[0]) ||
        values[0] <= 0 ||
        values[0] > LIMITS.cadence ||
        !("turns" in side.every || "minutes" in side.every)
      )
        throw new Error("INVALID_SIDE_CADENCE");
      visit(side.agent, depth + 1, next);
    }
    for (const child of agent.subagents) visit(child, depth + 1, next);
  }
  for (const root of config.agents) visit(root, 0, new Set());
  if (byName.size > LIMITS.agents) throw new Error("AGENT_LIMIT");
  return { byName, children, edges };
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
  side: v.optional(v.boolean()),
  assignmentId: v.optional(v.string()),
  turnToken: v.optional(v.string()),
  toolCallId: v.optional(v.string()),
  agent: v.optional(v.string()),
  task: v.optional(v.string()),
  runId: v.optional(v.string()),
  resultMessageId: v.optional(v.string()),
  errorCode: v.optional(runErrorCode),
  deliveryToken: v.optional(v.string()),
  group: v.optional(v.string()),
  wait: v.optional(v.union(v.literal("each"), v.literal("all"))),
  text: v.optional(v.string()),
  question: v.optional(v.string()),
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
  const limits = resolveLimits(config.limits);
  const graph = resolveGraph(config);
  if (
    !!config.models !== !!config.modelAllowlist ||
    (config.models !== undefined && typeof config.models !== "function") ||
    (config.modelAllowlist &&
      (config.modelAllowlist.length > LIMITS.modelAllowlist ||
        new Set(config.modelAllowlist).size !== config.modelAllowlist.length ||
        config.modelAllowlist.some((id) => !id || id.length > LIMITS.modelIdLength)))
  )
    throw new Error("INVALID_MODEL_REGISTRATION");
  for (const agent of graph.byName.values()) {
    const deferred = Object.entries(agent.declaredTools).filter(
      ([, tool]) => !tool.execute && tool.type !== "provider",
    );
    if (
      deferred.length > LIMITS.approvalsPerPause ||
      deferred.some(([name]) => !name || name.length > LIMITS.requestKeyLength)
    )
      throw new Error("INVALID_DEFERRED_TOOLS");
  }
  const collaboration =
    [...graph.edges.values()].some((allowed) => allowed.size > 0) ||
    [...graph.byName.values()].some((agent) => agent.sideAgents?.length);
  const agentIndexes = new Map([...graph.byName.keys()].sort().map((name, index) => [name, index]));
  if (collaboration && !config.refs.coordinate) throw new Error("COORDINATE_REF_REQUIRED");

  const watching = [...graph.byName.values()].some((agent) => agent.sideAgents?.length);

  async function saveTrackedMessage(
    ctx: CoordinatorCtx,
    native: ManagedAgent["component"],
    args: Parameters<typeof saveMessage>[2],
  ) {
    const saved = await saveMessage(ctx, native, args);
    if (watching)
      await ctx.runMutation(component.hooks.capture, {
        threadId: args.threadId,
        savedMessage: {
          id: saved.messageId,
          order: saved.message.order,
          stepOrder: saved.message.stepOrder,
          bytes: getConvexSize(saved.message),
        },
      });
    return saved;
  }

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
    // An untrusted reported id can fail the native id validator. Treat that
    // just like a missing document: no verified result, and no transcript scan.
    const found = await ctx
      .runQuery(child.component.messages.getMessagesByIds, {
        messageIds: [target.messageId],
      })
      .then(
        ([message]) => message,
        () => null,
      );
    if (
      !found ||
      found.threadId !== target.threadId ||
      found.message?.role !== "assistant" ||
      found.status !== "success" ||
      found.agentName !== target.agentName
    )
      return null;
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
    if (context.side && context.status === "failed" && context.errorCode === "EMPTY_RESULT") {
      await record("failed", context.errorCode);
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
      text = context.side
        ? verified
        : `${context.agent} completed the delegated task.\n\n${verified}`;
    } else {
      if (context.side) {
        await record("failed", context.errorCode);
        return null;
      }
      text = `${context.agent} failed the delegated task (${
        context.errorCode ?? "GENERATION_FAILED"
      }). No result was accepted.`;
    }
    const root = graph.byName.get(context.parentAgent);
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
    if (context.side) {
      if (text.trim() && text.trim() !== "NONE") {
        const row = await ctx.runQuery(component.queue.assignment, {
          threadId: context.parentThreadId,
        });
        const accepted =
          row &&
          (await postNote(ctx, component, root, row.assignmentId, {
            threadId: context.parentThreadId,
            text: text.slice(0, LIMITS.noteLength),
            from: context.agent,
          }));
        if (!accepted) {
          await record("failed", "DELIVERY_FAILED");
          return null;
        }
      }
      await record("accepted", null);
      return null;
    }
    const { messageId } = await saveTrackedMessage(ctx, root.component, {
      threadId: context.parentThreadId,
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
    note: async (ctx: CoordinatorCtx, args: NoteArgs): Promise<boolean> => {
      const scope = await ctx.runQuery(component.queue.assignment, { threadId: args.threadId });
      if (!scope) throw new Error("FORBIDDEN");
      const { subject } = await config.authorize(ctx, {
        operation: "note",
        agent: scope.agent,
        threadId: args.threadId,
      });
      const owned = scope.subject === subject ? scope : null;
      const managed = graph.byName.get(scope.agent);
      if (!owned || !managed) throw new Error("FORBIDDEN");
      return postNote(ctx, component, managed, owned.assignmentId, args);
    },
    authorizedEndpoints: () => authorizedEndpoints(component, config),
    internalFunctions: () => {
      const coordinate: RegisteredMutation<"internal", CoordinateArgs, CoordinateResult> =
        internalMutationGeneric({
          args: coordinateArgs,
          returns: v.union(
            delegationResult,
            v.object({ status: v.literal("accepted"), runId: v.string() }),
            v.object({ status: v.literal("deferred"), runId: v.string() }),
            v.null(),
          ),
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
              if (!task || task.length > limits.taskLength)
                return { status: "denied" as const, code: "TASK_LIMIT" as const };
              const owned = await ctx.runQuery(component.subagents.delegateContext, {
                assignmentId: args.assignmentId,
                turnToken: args.turnToken,
              });
              if (!owned) return { status: "denied" as const, code: "STALE_TURN" as const };
              if (
                args.side
                  ? !graph.byName
                      .get(owned.actorAgent)
                      ?.sideAgents?.some((side) => side.agent.name === args.agent)
                  : !graph.edges.get(owned.actorAgent)?.has(args.agent)
              )
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
              const side = args.side
                ? graph.byName
                    .get(owned.actorAgent)
                    ?.sideAgents?.find((side) => side.agent.name === args.agent)
                : undefined;
              const review = side
                ? await ctx.runQuery(component.hooks.reviewContext, {
                    assignmentId: args.assignmentId,
                    executionId: args.turnToken,
                    agent: args.agent,
                    ...side.every,
                  })
                : null;
              if (args.side && !review)
                return { status: "denied" as const, code: "RUN_BUDGET" as const };
              const reservation = await ctx.runMutation(component.subagents.reserve, {
                assignmentId: args.assignmentId,
                turnToken: args.turnToken,
                toolCallId: args.toolCallId,
                agent: args.agent,
                payloadFingerprint: await fingerprint([
                  owned.actorAgent,
                  args.agent,
                  task,
                  args.group ?? null,
                  args.wait ?? "each",
                ]),
                group: args.group,
                wait: args.wait,
                side: args.side,
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
              let childTask = task;
              if (review) {
                // Exact identities captured with native writes; no listMessages.
                // Metadata admits <=2 MiB of source docs; text-only output is
                // UTF-8 clipped to 48 KiB. Tools/reasoning never enter the fork.
                const parent = graph.byName.get(owned.actorAgent)!;
                const docs = await ctx.runQuery(parent.component.messages.getMessagesByIds, {
                  messageIds: review.refs.map((ref) => ref.id),
                });
                let remaining = LIMITS.contextBytes;
                const chunks: string[] = [];
                for (const doc of docs.reverse()) {
                  if (
                    !doc ||
                    !["user", "assistant"].includes(doc.message?.role ?? "") ||
                    remaining <= 0
                  )
                    continue;
                  const bytes = new TextEncoder().encode(`${doc.message!.role}: ${doc.text ?? ""}`);
                  // stream:true drops an incomplete trailing UTF-8 code point;
                  // replacement characters must not push output over the cap.
                  const chunk = new TextDecoder().decode(bytes.slice(0, remaining), {
                    stream: true,
                  });
                  chunks.unshift(chunk);
                  remaining -= new TextEncoder().encode(chunk).byteLength + 1;
                }
                childTask += "\n\n" + chunks.join("\n");
                await ctx.runMutation(component.hooks.reviewed, {
                  assignmentId: args.assignmentId,
                  executionId: args.turnToken,
                  agent: args.agent,
                  boundary: review.boundary,
                });
              }
              const threadId = await createThread(ctx, child.component, { userId: owned.subject });
              const { messageId, message } = await saveTrackedMessage(ctx, child.component, {
                threadId,
                prompt: childTask,
                userId: owned.subject,
              });
              await ctx.runMutation(component.subagents.attach, {
                runId: reservation.runId,
                childThreadId: threadId,
                promptMessageId: messageId,
                trackContext: !!child.sideAgents?.length,
                savedMessage: {
                  id: messageId,
                  order: message.order,
                  stepOrder: message.stepOrder,
                  bytes: getConvexSize(message),
                },
              });
              await observe(ctx, {
                type: "delegation.queued",
                runId: reservation.runId,
                rootAssignmentId: owned.rootAssignmentId,
                agent: args.agent,
              });
              return { status: "queued" as const, runId: reservation.runId, agent: args.agent };
            }

            // Each native save reads at most its one <=1 MiB tail document.
            // message: one <=128 KiB saved text projection; ask: two such
            // saves +one <=128 KiB exact question verification. Add <=2.25 MiB
            // bounded queue/group recovery and <128 KiB admission metadata:
            // either transaction stays <8 MiB, <600 reads and <128 writes.
            // No backlog or transcript body scan participates in admission.
            if (args.op === "message" || args.op === "ask") {
              const text = (args.op === "message" ? args.text : args.question).trim();
              if (!text || text.length > limits.taskLength)
                return { status: "denied" as const, code: "TASK_LIMIT" as const };
              const target = await ctx.runQuery(component.subagents.interactionContext, {
                assignmentId: args.assignmentId,
                turnToken: args.turnToken,
                op: args.op,
                ...(args.op === "message" ? { runId: args.runId } : {}),
              });
              if (target.kind === "denied") return { status: "denied" as const, code: target.code };
              if (args.op === "message" && !graph.edges.get(target.actorAgent)?.size)
                return { status: "denied" as const, code: "FORBIDDEN" as const };
              const childAgent = graph.children.get(target.agent);
              const parent = graph.byName.get(target.actorAgent);
              if (!childAgent || !parent)
                return { status: "denied" as const, code: "FORBIDDEN" as const };
              // Reuse background launch/delivery policy, with trusted persisted
              // identities. All native writes and admission share this transaction.
              try {
                const authorized = await config.authorize(
                  ctx,
                  args.op === "message"
                    ? {
                        operation: "delegate",
                        agent: target.rootAgent,
                        threadId: target.rootThreadId,
                        subject: target.subject,
                        rootAssignmentId: target.rootAssignmentId,
                        rootAgent: target.rootAgent,
                        actorAgent: target.actorAgent,
                        childAgent: target.agent,
                        task: text,
                      }
                    : {
                        operation: "deliver",
                        agent: target.rootAgent,
                        threadId: target.rootThreadId,
                        subject: target.subject,
                        rootAssignmentId: target.rootAssignmentId,
                        rootAgent: target.rootAgent,
                        actorAgent: target.actorAgent,
                        childAgent: target.agent,
                        runId: target.runId,
                      },
                );
                if (authorized.subject !== target.subject)
                  return { status: "denied" as const, code: "FORBIDDEN" as const };
              } catch {
                return { status: "denied" as const, code: "FORBIDDEN" as const };
              }
              if (args.op === "message") {
                const { messageId } = await saveTrackedMessage(ctx, childAgent.component, {
                  threadId: target.childThreadId,
                  prompt: text,
                  userId: target.subject,
                });
                return ctx.runMutation(component.subagents.messageChild, {
                  assignmentId: args.assignmentId,
                  turnToken: args.turnToken,
                  runId: args.runId,
                  messageId,
                });
              }
              const { messageId: questionMessageId } = await saveMessage(
                ctx,
                childAgent.component,
                {
                  threadId: target.childThreadId,
                  agentName: target.agent,
                  message: { role: "assistant", content: text },
                },
              );
              const parentAgent = graph.byName.get(target.parentAgent);
              if (!parentAgent) throw new Error("FORBIDDEN");
              const { messageId: parentMessageId } = await saveTrackedMessage(
                ctx,
                parentAgent.component,
                {
                  threadId: target.parentThreadId,
                  prompt: target.agent + " asks (run " + target.runId + "):\n\n" + text,
                  agentName: target.agent,
                  userId: target.subject,
                },
              );
              const response = await ctx.runMutation(component.subagents.askParent, {
                assignmentId: args.assignmentId,
                turnToken: args.turnToken,
                questionMessageId,
                parentMessageId,
              });
              const recorded = await ctx.runQuery(component.subagents.questionContext, {
                runId: target.runId,
              });
              if (
                !recorded ||
                !(await verifyChildMessage(ctx, {
                  threadId: target.childThreadId,
                  agentName: target.agent,
                  messageId: recorded,
                  subject: target.subject,
                }))
              )
                throw new Error("RESULT_UNVERIFIED");
              return response;
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
                const reported =
                  args.resultMessageId === settlement.childResultMessageId
                    ? args.resultMessageId
                    : undefined;
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
              if (settlement.blocked) return { status: "deferred" as const, runId: args.runId };
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
          });
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
                  return await ctx.runMutation(component.queue.write, {
                    assignmentId: args.assignmentId,
                    executionId: args.turnToken,
                    cancellationEpoch: claimed.cancellationEpoch,
                    handle: await createFunctionHandle(ref),
                    args: payload,
                    rejectStale: true,
                    ...(JSON.stringify(getFunctionAddress(ref)) ===
                    JSON.stringify(getFunctionAddress(managed.component.streams.create))
                      ? {
                          nativeStream: await createFunctionHandle(managed.component.streams.abort),
                        }
                      : {}),
                    ...(JSON.stringify(getFunctionAddress(ref)) ===
                    JSON.stringify(getFunctionAddress(managed.component.messages.addMessages))
                      ? {
                          // Tools without execute are native deferred calls (Agent
                          // 0.7.7 example/convex/chat/human.ts:125-157). Supply
                          // names only at the native-save seam; no transcript scan.
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
                } catch (error) {
                  if (error instanceof ConvexError && error.data?.code === "CANCELLED")
                    controller.abort();
                  throw error;
                }
              }) as RunnerCtx["runMutation"],
            };
            let hookFailed = false;
            let hookBlocked = false;
            const hc: HookContext = {
              ctx: fencedCtx,
              subject: claimed.subject,
              threadId: claimed.threadId,
              runId: claimed.runId,
              signal: controller.signal,
              meter: noopMeter,
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
                  await fencedCtx.runMutation(component.hooks.addNote, {
                    assignmentId: claimed.assignmentId,
                    text: result.note,
                    from: managed.name,
                    addMessages: await createFunctionHandle(managed.component.messages.addMessages),
                  });
                return result;
              } catch (error) {
                hookFailed = true;
                await ctx.runMutation(component.hooks.hookState, {
                  assignmentId: claimed.assignmentId,
                  executionId: args.turnToken,
                  error: String(error),
                });
                controller.abort();
                throw new Error("HOOK_FAILED");
              }
            };
            try {
              let selectedModel = claimed.modelId;
              if (claimed.isTurnStart && managed.hooks?.beforeTurn) {
                const docs = await ctx.runQuery(managed.component.messages.getMessagesByIds, {
                  messageIds: [claimed.promptMessageId],
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
                Object.entries(managed.declaredTools).map(([name, declared]) => [
                  name,
                  bindOnceTool(
                    declared,
                    component,
                    ctx,
                    {
                      ctx: fencedCtx,
                      subject: claimed.subject,
                      threadId: claimed.threadId,
                      runId: claimed.runId,
                      signal: controller.signal,
                      meter: noopMeter,
                    },
                    {
                      assignmentId: args.assignmentId,
                      executionId: args.turnToken,
                      cancellationEpoch: claimed.cancellationEpoch,
                    },
                    limits.leaseMs,
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
                    const output = await execute.call(this, actual, options);
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
              const notes = await fencedCtx.runMutation(component.hooks.takeNotes, {
                assignmentId: claimed.assignmentId,
                executionId: args.turnToken,
                getMessages: await createFunctionHandle(
                  managed.component.messages.getMessagesByIds,
                ),
              });
              const result = await managed.streamText(
                fencedCtx,
                { threadId: claimed.threadId },
                {
                  promptMessageId: claimed.promptMessageId,
                  // Agent 0.7.7 src/vercel/client/start.ts:119-127 orders these
                  // after recent history and before the anchor's prompt group.
                  // saveInputMessages.ts:48-50 saves no input when an anchor is
                  // supplied: notes already live in the thread, without copies
                  // or moving this slice across another queued request.
                  messages: notes,
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
              if (
                after?.continue &&
                (await fencedCtx.runMutation(component.hooks.continueAdmission, {
                  assignmentId: claimed.assignmentId,
                  executionId: args.turnToken,
                }))
              ) {
                if (!after.continue.trim() || after.continue.length > LIMITS.messageLength)
                  await hook(() => {
                    throw new Error("INVALID_CONTINUE");
                  });
                const { messageId } = await saveMessage(fencedCtx, managed.component, {
                  threadId: claimed.threadId,
                  prompt: after.continue,
                  userId: claimed.subject,
                });
                await fencedCtx.runMutation(component.queue.continueTurn, {
                  assignmentId: claimed.assignmentId,
                  executionId: args.turnToken,
                  cancellationEpoch: claimed.cancellationEpoch,
                  messageId,
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
          await ctx.runMutation(component.queue.finish, {
            assignmentId: args.assignmentId,
            turnToken: args.turnToken,
            errorCode,
          });
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
