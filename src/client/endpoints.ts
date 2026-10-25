import {
  createThread,
  listUIMessages,
  saveMessage,
  syncStreams,
  vStreamArgs,
  vStreamMessagesReturnValue,
  type UIMessage,
} from "@convex-dev/agent";
import type { StreamArgs } from "@convex-dev/agent/validators";
import {
  createFunctionHandle,
  mutationGeneric,
  queryGeneric,
  paginationOptsValidator,
  type GenericDataModel,
  type GenericMutationCtx,
  type GenericQueryCtx,
  type PaginationResult,
} from "convex/server";
import { ConvexError, getConvexSize, v, type Validator } from "convex/values";
import { fingerprint } from "./once.js";
import { LIMITS, resolveLimits } from "../component/limits.js";
import type { ComponentApi } from "../component/_generated/component.js";
import { modelOverrides, validModelOverrides } from "../component/models.js";
import { activity, receipt, subagentRun, vPaginationResult } from "../component/schema.js";
import type { AgentEvent, ManagedAgent, Registration } from "./types.js";

async function observe(
  ctx: GenericMutationCtx<GenericDataModel>,
  config: Registration,
  event: AgentEvent,
) {
  try {
    await config.observe?.(ctx, event);
  } catch {
    // Observability is best effort and must never change the request outcome.
  }
}

// UI parts are upstream AI SDK extensible unions. Preserve them unchanged and
// validate the envelope; reuse native stream validators rather than raw MessageDoc.
export type OriginMessage = UIMessage & {
  origin: "user" | "result" | "note" | "continue";
  from?: string;
  runId?: string;
};
const uiMessage = v.object({
  origin: v.union(v.literal("user"), v.literal("result"), v.literal("note"), v.literal("continue")),
  from: v.optional(v.string()),
  runId: v.optional(v.string()),
  id: v.string(),
  key: v.string(),
  role: v.union(v.literal("system"), v.literal("user"), v.literal("assistant")),
  parts: v.array(v.any()),
  metadata: v.optional(v.any()),
  order: v.number(),
  stepOrder: v.number(),
  status: v.union(
    v.literal("streaming"),
    v.literal("pending"),
    v.literal("success"),
    v.literal("failed"),
  ),
  agentName: v.optional(v.string()),
  userId: v.optional(v.string()),
  text: v.string(),
  _creationTime: v.number(),
}) as unknown as Validator<OriginMessage>;
const messagesReturn = v.object({
  page: v.array(uiMessage),
  isDone: v.boolean(),
  continueCursor: v.string(),
  splitCursor: v.optional(v.union(v.string(), v.null())),
  pageStatus: v.optional(
    v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null()),
  ),
});

function validateInput(text: string, requestKey: string) {
  if (!text.trim() || text.length > LIMITS.messageLength) return "INVALID_MESSAGE" as const;
  if (!requestKey || requestKey.length > LIMITS.requestKeyLength)
    return "INVALID_REQUEST_KEY" as const;
}

export function authorizedEndpoints(component: ComponentApi, config: Registration) {
  const limits = resolveLimits(config.limits);
  // A managed conversation is always a native thread, including a delegated
  // conversation. Index the entire registered graph so a persisted assignment's
  // agent name resolves to the correct native component for transcript reads.
  // Walk recursively rather than baking today's delegation-depth limit into the
  // reader, and visit shared agents once. Registration validates name uniqueness
  // and graph shape before these endpoints are constructed.
  const managedAgents = new Map<string, ManagedAgent>();
  function include(managed: ManagedAgent) {
    if (managedAgents.has(managed.name)) return;
    managedAgents.set(managed.name, managed);
    for (const child of managed.subagents) include(child);
    for (const side of managed.sideAgents ?? []) include(side.agent);
  }
  for (const root of config.agents) include(root);

  // Opening a new public conversation still resolves roots only. Merely being
  // readable through an owned child thread must not expose a child as a root.
  function agent(name: string) {
    const found = config.agents.find((a) => a.name === name);
    if (!found) throw new Error("UNKNOWN_AGENT");
    return found;
  }
  async function owned(
    ctx: GenericQueryCtx<GenericDataModel>,
    threadId: string,
    operation: "send" | "respond" | "answer" | "cancel" | "messages" | "streams" | "activity",
  ) {
    const row = await ctx.runQuery(component.queue.assignment, { threadId });
    if (!row) throw new Error("FORBIDDEN");
    const trusted = await config.authorize(ctx, { operation, agent: row.agent, threadId });
    if (!trusted.subject || trusted.subject !== row.subject) throw new Error("FORBIDDEN");
    // Ownership permits reading a child's transcript and resolving its recorded
    // approvals. Child turns belong to the coordinator's bounded delegation and
    // settlement path; accepting a public send could start another child turn
    // outside that path. Keep send and coordination reads (activity/delegations)
    // root-only; messages/respond use the same ownership check for every thread.
    // The role must come from the persisted assignment, not today's root names:
    // a later deployment can register a former child agent as a root without
    // changing the role of any existing child thread. A name-based check would
    // grant send/activity access to those old threads (and previously also let
    // a shared Agent object registered as both root and child bypass the guard).
    if (
      operation !== "messages" &&
      operation !== "streams" &&
      operation !== "respond" &&
      operation !== "answer" &&
      row.root === false
    )
      throw new Error("FORBIDDEN");
    const native = managedAgents.get(row.agent);
    if (!native) throw new Error("UNKNOWN_AGENT");
    return { ...row, native };
  }
  function validModels(models: Record<string, string> | undefined, root: ManagedAgent) {
    if (models === undefined) return true;
    const reachable = new Set<string>();
    function visit(agent: ManagedAgent) {
      if (reachable.has(agent.name)) return;
      reachable.add(agent.name);
      for (const child of agent.subagents) visit(child);
    }
    visit(root);
    return (
      validModelOverrides(models) &&
      Object.entries(models).every(
        ([name, id]) => reachable.has(name) && config.modelAllowlist?.includes(id),
      )
    );
  }
  return {
    open: mutationGeneric({
      args: {
        agent: v.string(),
        prompt: v.string(),
        requestKey: v.string(),
        models: v.optional(modelOverrides),
      },
      returns: receipt,
      handler: async (ctx, args) => {
        const { subject } = await config.authorize(ctx, { operation: "open", agent: args.agent });
        if (!subject) throw new Error("FORBIDDEN");
        const invalid = validateInput(args.prompt, args.requestKey);
        if (invalid) return { status: "rejected" as const, code: invalid };
        if (!config.agents.some((a) => a.name === args.agent))
          return { status: "rejected" as const, code: "UNKNOWN_AGENT" as const };
        const native = agent(args.agent);
        if (!validModels(args.models, native))
          return { status: "rejected" as const, code: "INVALID_MODELS" as const };
        if (subject.length > LIMITS.requestKeyLength) throw new Error("INVALID_SUBJECT");
        const hash = await fingerprint(["open", args.agent, args.prompt, args.models ?? null]);
        const duplicate = await ctx.runQuery(component.queue.lookupReceipt, {
          subject,
          requestKey: args.requestKey,
          fingerprint: hash,
        });
        if (duplicate) return duplicate;
        const runTurn = await createFunctionHandle(config.refs.runTurn());
        const threadId = await createThread(ctx, native.component, { userId: subject });
        const { messageId, message } = await saveMessage(ctx, native.component, {
          threadId,
          prompt: args.prompt,
          // Reserve order zero for notes posted before the first turn claim.
          order: LIMITS.firstPromptOrder,
          userId: subject,
        });
        const accepted = await ctx.runMutation(component.queue.accept, {
          subject,
          agent: args.agent,
          threadId,
          requestKey: args.requestKey,
          fingerprint: hash,
          promptMessageId: messageId,
          trackContext: !!native.sideAgents?.length,
          savedMessage: {
            id: messageId,
            order: message.order,
            stepOrder: message.stepOrder,
            bytes: getConvexSize(message),
          },
          runTurn,
          limits,
          models: args.models,
        });
        if (accepted.status !== "accepted") throw new Error("ADMISSION_CHANGED");
        await observe(ctx, config, {
          type: "request.accepted",
          operation: "open",
          assignmentId: accepted.assignmentId,
          threadId: accepted.threadId,
          agent: args.agent,
        });
        return accepted;
      },
    }),
    send: mutationGeneric({
      args: {
        threadId: v.string(),
        text: v.string(),
        requestKey: v.string(),
        models: v.optional(modelOverrides),
      },
      returns: receipt,
      handler: async (ctx, args) => {
        const row = await owned(ctx, args.threadId, "send");
        const invalid = validateInput(args.text, args.requestKey);
        if (invalid) return { status: "rejected" as const, code: invalid };
        if (!validModels(args.models, row.native))
          return { status: "rejected" as const, code: "INVALID_MODELS" as const };
        const hash = await fingerprint(["send", args.threadId, args.text, args.models ?? null]);
        const duplicate = await ctx.runQuery(component.queue.lookupReceipt, {
          subject: row.subject,
          requestKey: args.requestKey,
          fingerprint: hash,
        });
        if (duplicate) return duplicate;
        const refusal = await ctx.runQuery(component.queue.admission, {
          threadId: args.threadId,
          subject: row.subject,
        });
        if (refusal) return refusal;
        const { messageId, message } = await saveMessage(ctx, row.native.component, {
          threadId: args.threadId,
          prompt: args.text,
          userId: row.subject,
        });
        const accepted = await ctx.runMutation(component.queue.accept, {
          subject: row.subject,
          agent: row.agent,
          threadId: args.threadId,
          requestKey: args.requestKey,
          fingerprint: hash,
          promptMessageId: messageId,
          trackContext: !!row.native.sideAgents?.length,
          savedMessage: {
            id: messageId,
            order: message.order,
            stepOrder: message.stepOrder,
            bytes: getConvexSize(message),
          },
          runTurn: await createFunctionHandle(config.refs.runTurn()),
          limits,
          models: args.models,
        });
        if (accepted.status !== "accepted") throw new Error("ADMISSION_CHANGED");
        await observe(ctx, config, {
          type: "request.accepted",
          operation: "send",
          assignmentId: accepted.assignmentId,
          threadId: accepted.threadId,
          agent: row.agent,
        });
        return accepted;
      },
    }),
    respond: mutationGeneric({
      args: {
        threadId: v.string(),
        approvalId: v.string(),
        approved: v.boolean(),
        reason: v.optional(v.string()),
      },
      returns: v.object({ messageId: v.string() }),
      handler: async (ctx, args) => {
        const row = await owned(ctx, args.threadId, "respond");
        return ctx.runMutation(component.queue.respond, {
          assignmentId: row.assignmentId,
          subject: row.subject,
          approvalId: args.approvalId,
          approved: args.approved,
          ...(args.reason !== undefined ? { reason: args.reason } : {}),
          addMessages: await createFunctionHandle(row.native.component.messages.addMessages),
        });
      },
    }),
    answer: mutationGeneric({
      args: { threadId: v.string(), toolCallId: v.string(), text: v.string() },
      returns: v.object({ messageId: v.string() }),
      handler: async (ctx, args) => {
        const row = await owned(ctx, args.threadId, "answer");
        return ctx.runMutation(component.queue.answer, {
          assignmentId: row.assignmentId,
          subject: row.subject,
          toolCallId: args.toolCallId,
          text: args.text,
        });
      },
    }),
    cancel: mutationGeneric({
      args: { threadId: v.string() },
      returns: v.null(),
      handler: async (ctx, args) => {
        const row = await owned(ctx, args.threadId, "cancel");
        await ctx.runMutation(component.queue.cancel, {
          assignmentId: row.assignmentId,
          subject: row.subject,
        });
        return null;
      },
    }),
    messages: queryGeneric({
      args: {
        threadId: v.string(),
        paginationOpts: paginationOptsValidator,
      },
      returns: messagesReturn,
      handler: async (ctx, args): Promise<PaginationResult<OriginMessage>> => {
        const row = await owned(ctx, args.threadId, "messages");
        // Clamp the client's page to the server's count and byte bounds (see
        // LIMITS.messagePage); a smaller page only means one more cursor hop.
        const { numItems, maximumBytesRead, maximumRowsRead } = args.paginationOpts;
        for (const value of [numItems, maximumBytesRead, maximumRowsRead]) {
          if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
            throw new ConvexError({ code: "INVALID_PAGINATION" });
        }
        const paginationOpts = {
          ...args.paginationOpts,
          numItems: Math.min(numItems, LIMITS.messagePage),
          maximumRowsRead: Math.min(maximumRowsRead ?? LIMITS.messagePage, LIMITS.messagePage),
          maximumBytesRead: Math.min(
            maximumBytesRead ?? LIMITS.messagePageBytes,
            LIMITS.messagePageBytes,
          ),
        };
        const page: PaginationResult<UIMessage> = await listUIMessages(ctx, row.native.component, {
          ...args,
          paginationOpts,
        });
        const origins = await ctx.runQuery(component.hooks.origins, {
          assignmentId: row.assignmentId,
          subject: row.subject,
          messageIds: page.page.map((message) => message.id),
        });
        return {
          ...page,
          page: page.page.map((message) => ({
            ...message,
            ...(origins[message.id] ?? { origin: "user" as const }),
          })),
        };
      },
    }),
    streams: queryGeneric({
      args: { threadId: v.string(), streamArgs: vStreamArgs },
      returns: v.object({ streams: vStreamMessagesReturnValue.fields.streams }),
      handler: async (ctx, args) => {
        const row = await owned(ctx, args.threadId, "streams");
        return { streams: await boundedStreams(ctx, row, args.streamArgs) };
      },
    }),
    activity: queryGeneric({
      args: { threadId: v.string() },
      returns: activity,
      handler: async (ctx, args) => {
        const row = await owned(ctx, args.threadId, "activity");
        return ctx.runQuery(component.queue.activity, {
          threadId: args.threadId,
          subject: row.subject,
        });
      },
    }),
    /**
     * Newest-first page of one root's delegated child runs.
     *
     * Authorized exactly like the other subject-owned coordination reads, using
     * the existing `activity` operation: it is a projection of the same
     * thread's coordination state, and the frozen authorization scope has no
     * separate delegation-read variant. Ownership is therefore established by the
     * host policy first and re-checked against the persisted subject by the
     * component query.
     *
     * Returns coordination records with the child's native thread id once it
     * exists, so its owner can read that conversation through `messages`.
     * Execution and delivery tokens stay private. The delivered result in the
     * native parent transcript remains reachable through `resultMessageId`.
     */
    /** Return the current request's full delegation tree after root ownership authorization. */
    runTree: queryGeneric({
      args: { threadId: v.string() },
      handler: async (ctx, args) => {
        const row = await owned(ctx, args.threadId, "activity");
        return ctx.runQuery(component.subagents.runTree, {
          threadId: args.threadId,
          subject: row.subject,
        });
      },
    }),
    delegations: queryGeneric({
      args: { threadId: v.string(), paginationOpts: paginationOptsValidator },
      returns: vPaginationResult(subagentRun),
      handler: async (ctx, args) => {
        const row = await owned(ctx, args.threadId, "activity");
        return ctx.runQuery(component.subagents.delegations, {
          threadId: args.threadId,
          subject: row.subject,
          paginationOpts: args.paginationOpts,
        });
      },
    }),
  };
}

async function boundedStreams(
  ctx: GenericQueryCtx<GenericDataModel>,
  row: { threadId: string; native: ManagedAgent },
  args?: StreamArgs,
) {
  if (!args) return undefined;
  if (args.kind === "list") {
    if (
      args.startOrder !== undefined &&
      (!Number.isSafeInteger(args.startOrder) || args.startOrder < 0)
    )
      throw new ConvexError({ code: "INVALID_STREAM_ORDER" });
    // Accepted upstream exception, like Agent's context reader (spec §9b):
    // Agent 0.7.7 streams.list reads at most 100 streaming-state metadata docs.
    return syncStreams(ctx, row.native.component, { threadId: row.threadId, streamArgs: args });
  }
  // Deduplicate by id (including cursors at different offsets), keeping the
  // earliest offset so data isn't skipped. Agent byte-bounds the shared page;
  // the cursor cap bounds its one metadata-document read per stream.
  const cursors = new Map<string, number>();
  for (const { streamId, cursor } of args.cursors) {
    if (!Number.isSafeInteger(cursor) || cursor < 0)
      throw new ConvexError({ code: "INVALID_STREAM_CURSOR" });
    cursors.set(streamId, Math.min(cursors.get(streamId) ?? cursor, cursor));
  }
  return syncStreams(ctx, row.native.component, {
    threadId: row.threadId,
    streamArgs: {
      ...args,
      cursors: [...cursors]
        .slice(0, LIMITS.streamCursors)
        .map(([streamId, cursor]) => ({ streamId, cursor })),
    },
  });
}
