import {
  createThread,
  listUIMessages,
  listMessages,
  saveMessage,
  syncStreams,
  vStreamArgs,
  vStreamMessagesReturnValue,
  type UIMessage,
} from "@convex-dev/agent";
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
import { v, type Validator } from "convex/values";
import { fingerprint } from "./once.js";
import { LIMITS, resolveLimits } from "../component/limits.js";
import type { ComponentApi } from "../component/_generated/component.js";
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
const uiMessage = v.object({
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
}) as unknown as Validator<UIMessage>;
const messagesReturn = v.object({
  page: v.array(uiMessage),
  isDone: v.boolean(),
  continueCursor: v.string(),
  splitCursor: v.optional(v.union(v.string(), v.null())),
  pageStatus: v.optional(
    v.union(v.literal("SplitRecommended"), v.literal("SplitRequired"), v.null()),
  ),
  streams: vStreamMessagesReturnValue.fields.streams,
});

function validateInput(text: string, requestKey: string) {
  if (!text.trim() || text.length > LIMITS.messageLength) throw new Error("INVALID_MESSAGE");
  if (!requestKey || requestKey.length > LIMITS.requestKeyLength)
    throw new Error("INVALID_REQUEST_KEY");
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
    operation: "send" | "cancel" | "messages" | "activity",
  ) {
    const row = await ctx.runQuery(component.queue.assignment, { threadId });
    if (!row) throw new Error("FORBIDDEN");
    const trusted = await config.authorize(ctx, { operation, agent: row.agent, threadId });
    if (!trusted.subject || trusted.subject !== row.subject) throw new Error("FORBIDDEN");
    // Ownership permits reading a child's transcript, not driving its managed
    // lifecycle. Child turns belong to the coordinator's bounded delegation and
    // settlement path; accepting a public send could start another child turn
    // outside that path. Keep send and coordination reads (activity/delegations)
    // root-only, while messages uses the same ownership check for every thread.
    // The role must come from the persisted assignment, not today's root names:
    // a later deployment can register a former child agent as a root without
    // changing the role of any existing child thread. A name-based check would
    // grant send/activity access to those old threads (and previously also let
    // a shared Agent object registered as both root and child bypass the guard).
    if (operation !== "messages" && row.root === false) throw new Error("FORBIDDEN");
    const native = managedAgents.get(row.agent);
    if (!native) throw new Error("UNKNOWN_AGENT");
    return { ...row, native };
  }
  return {
    open: mutationGeneric({
      args: { agent: v.string(), prompt: v.string(), requestKey: v.string() },
      returns: receipt,
      handler: async (ctx, args) => {
        validateInput(args.prompt, args.requestKey);
        const native = agent(args.agent);
        const { subject } = await config.authorize(ctx, { operation: "open", agent: args.agent });
        if (!subject) throw new Error("FORBIDDEN");
        const hash = await fingerprint(["open", args.agent, args.prompt]);
        const duplicate = await ctx.runQuery(component.queue.lookupReceipt, {
          subject,
          requestKey: args.requestKey,
          fingerprint: hash,
        });
        if (duplicate) return duplicate;
        const runTurn = await createFunctionHandle(config.refs.runTurn());
        const threadId = await createThread(ctx, native.component, { userId: subject });
        const { messageId } = await saveMessage(ctx, native.component, {
          threadId,
          prompt: args.prompt,
          userId: subject,
        });
        const accepted = await ctx.runMutation(component.queue.accept, {
          subject,
          agent: args.agent,
          threadId,
          requestKey: args.requestKey,
          fingerprint: hash,
          promptMessageId: messageId,
          runTurn,
          limits,
        });
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
      args: { threadId: v.string(), text: v.string(), requestKey: v.string() },
      returns: receipt,
      handler: async (ctx, args) => {
        validateInput(args.text, args.requestKey);
        const row = await owned(ctx, args.threadId, "send");
        const hash = await fingerprint(["send", args.threadId, args.text]);
        const duplicate = await ctx.runQuery(component.queue.lookupReceipt, {
          subject: row.subject,
          requestKey: args.requestKey,
          fingerprint: hash,
        });
        if (duplicate) return duplicate;
        const { messageId } = await saveMessage(ctx, row.native.component, {
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
          runTurn: await createFunctionHandle(config.refs.runTurn()),
          limits,
        });
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
    cancel: mutationGeneric({
      args: { threadId: v.string() },
      returns: v.null(),
      handler: async (ctx, args) => {
        const row = await owned(ctx, args.threadId, "cancel");
        const affected = await ctx.runMutation(component.queue.cancel, {
          assignmentId: row.assignmentId,
          subject: row.subject,
        });
        // These are cancellation-owned writes, after the epoch fence is set.
        // Running actions must drop their later saves, so the authorized cancel
        // transaction itself closes native streams and pending placeholders.
        for (const thread of affected) {
          const native = managedAgents.get(thread.agent);
          if (!native) continue;
          const streams = await ctx.runQuery(native.component.streams.list, {
            threadId: thread.threadId,
            statuses: ["streaming"],
          });
          for (const stream of streams)
            await ctx.runMutation(native.component.streams.abort, {
              streamId: stream.streamId,
              reason: "CANCELLED",
            });
          // A running placeholder may precede an entire full inbox of newer
          // prompts. Agent 0.7.7 indexes this status filter, so cleanup must page
          // pending messages themselves rather than scan the newest transcript.
          let cursor: string | null = null;
          for (;;) {
            const pending = await listMessages(ctx, native.component, {
              threadId: thread.threadId,
              statuses: ["pending"],
              paginationOpts: { cursor, numItems: LIMITS.verificationPage },
            });
            for (const message of pending.page)
              await ctx.runMutation(native.component.messages.finalizeMessage, {
                messageId: message._id,
                result: { status: "failed", error: "CANCELLED" },
              });
            if (pending.isDone) break;
            cursor = pending.continueCursor;
          }
        }
        return null;
      },
    }),
    messages: queryGeneric({
      args: {
        threadId: v.string(),
        paginationOpts: paginationOptsValidator,
        streamArgs: v.optional(vStreamArgs),
      },
      returns: messagesReturn,
      handler: async (ctx, args) => {
        const row = await owned(ctx, args.threadId, "messages");
        const page: PaginationResult<UIMessage> = await listUIMessages(
          ctx,
          row.native.component,
          args,
        );
        const streams = await syncStreams(ctx, row.native.component, args);
        return { ...page, streams };
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
