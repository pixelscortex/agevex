import {
  createThread,
  listUIMessages,
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
  type GenericQueryCtx,
  type PaginationResult,
} from "convex/server";
import { v, type Validator } from "convex/values";
import type { ComponentApi } from "../component/_generated/component.js";
import { activity, receipt, subagentRun, vPaginationResult } from "../component/schema.js";
import type { Registration } from "./types.js";

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

async function fingerprint(input: unknown) {
  const bytes = new TextEncoder().encode(JSON.stringify(input));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}
function validateInput(text: string, requestKey: string) {
  if (!text.trim() || text.length > 16_000) throw new Error("INVALID_MESSAGE");
  if (!requestKey || requestKey.length > 200) throw new Error("INVALID_REQUEST_KEY");
}

export function authorizedEndpoints(component: ComponentApi, config: Registration) {
  function agent(name: string) {
    const found = config.agents.find((a) => a.name === name);
    if (!found) throw new Error("UNKNOWN_AGENT");
    return found;
  }
  async function owned(
    ctx: GenericQueryCtx<GenericDataModel>,
    threadId: string,
    operation: "send" | "messages" | "activity",
  ) {
    const row = await ctx.runQuery(component.queue.assignment, { threadId });
    if (!row) throw new Error("FORBIDDEN");
    const trusted = await config.authorize(ctx, { operation, agent: row.agent, threadId });
    if (!trusted.subject || trusted.subject !== row.subject) throw new Error("FORBIDDEN");
    return { ...row, native: agent(row.agent) };
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
        return ctx.runMutation(component.queue.accept, {
          subject,
          agent: args.agent,
          threadId,
          requestKey: args.requestKey,
          fingerprint: hash,
          promptMessageId: messageId,
          runTurn,
        });
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
        return ctx.runMutation(component.queue.accept, {
          subject: row.subject,
          agent: row.agent,
          threadId: args.threadId,
          requestKey: args.requestKey,
          fingerprint: hash,
          promptMessageId: messageId,
          runTurn: await createFunctionHandle(config.refs.runTurn()),
        });
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
     * Returns coordination records only. There is no child transcript endpoint,
     * no child thread id and no execution or delivery token in the payload; the
     * actual result text lives in the native parent transcript and is reachable
     * through `resultMessageId`.
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
