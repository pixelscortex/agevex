// Public read endpoints for an owned thread.
//
// `messages` pages the native transcript (clamped to the server's count and byte
// bounds) and labels each message with its origin (`hooks.origins.origins`); `streams`
// syncs native stream deltas with bounded cursors; `activity`, `runTree` and
// `delegations` project the thread's coordination state (`turns.send.activity`,
// `subagents.history.runTree`, `subagents.history.delegations`). Each runs the `ownedThread` gate
// first; `activity`/`runTree`/`delegations` are root-only.

import {
  listUIMessages,
  syncStreams,
  vStreamArgs,
  vStreamMessagesReturnValue,
  type UIMessage,
} from "@convex-dev/agent";
import type { StreamArgs } from "@convex-dev/agent/validators";
import {
  paginationOptsValidator,
  queryGeneric,
  type GenericDataModel,
  type GenericQueryCtx,
  type PaginationOptions,
  type PaginationResult,
} from "convex/server";
import { ConvexError, v, type Validator } from "convex/values";
import { valueBytes } from "../../shared/json.js";
import { LIMITS } from "../../component/limits.js";
import { assertFact } from "../../component/facts.js";
import { activity, subagentRun, vPaginationResult } from "../../component/schema.js";
import { runTree, TREE_LIMITS } from "../../component/run_tree_values.js";
import type { ManagedAgent } from "../types.js";
import { ownedThread, type EndpointContext } from "./access.js";

// UI parts are upstream AI SDK extensible unions. Preserve them unchanged and
// validate the envelope; reuse native stream validators rather than raw MessageDoc.
export type OriginMessage = UIMessage & {
  origin: "user" | "result" | "note";
  from?: string;
  runId?: string;
};

const uiMessage = v.object({
  origin: v.union(v.literal("user"), v.literal("result"), v.literal("note")),
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

/** `messages`: one origin-labelled page of the thread's native transcript. */
export function messagesEndpoint(ep: EndpointContext) {
  return queryGeneric({
    args: {
      threadId: v.string(),
      paginationOpts: paginationOptsValidator,
    },
    returns: messagesReturn,
    handler: async (ctx, args): Promise<PaginationResult<OriginMessage>> => {
      const row = await ownedThread(ep, ctx, args.threadId, "messages");

      const page: PaginationResult<UIMessage> = await listUIMessages(ctx, row.native.component, {
        ...args,
        paginationOpts: clampPage(args.paginationOpts),
      });

      const origins = await ctx.runQuery(ep.component.hooks.origins.origins, {
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
  });
}

/**
 * Clamp the client's page to the server's count and byte bounds (see
 * LIMITS.messagePage); a smaller page only means one more cursor hop. Negative
 * or non-integer bounds are rejected with `INVALID_PAGINATION`.
 */
function clampPage(paginationOpts: PaginationOptions) {
  const { numItems, maximumBytesRead, maximumRowsRead } = paginationOpts;

  for (const value of [numItems, maximumBytesRead, maximumRowsRead]) {
    if (value !== undefined && (!Number.isSafeInteger(value) || value < 0))
      throw new ConvexError({ code: "INVALID_PAGINATION" });
  }

  return {
    ...paginationOpts,
    numItems: Math.min(numItems, LIMITS.messagePage),
    maximumRowsRead: Math.min(maximumRowsRead ?? LIMITS.messagePage, LIMITS.messagePage),
    maximumBytesRead: Math.min(
      maximumBytesRead ?? LIMITS.messagePageBytes,
      LIMITS.messagePageBytes,
    ),
  };
}

/** `streams`: native stream sync for the thread, with bounded cursors. */
export function streamsEndpoint(ep: EndpointContext) {
  return queryGeneric({
    args: { threadId: v.string(), streamArgs: vStreamArgs },
    returns: v.object({ streams: vStreamMessagesReturnValue.fields.streams }),
    handler: async (ctx, args) => {
      const row = await ownedThread(ep, ctx, args.threadId, "streams");

      return { streams: await boundedStreams(ctx, row, args.streamArgs) };
    },
  });
}

/**
 * Bounded native stream sync. `list` reads at most Agent's own bounded stream
 * metadata; `deltas` deduplicates cursors and caps them at `LIMITS.streamCursors`.
 */
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

/** `activity`: the owned root thread's current queue activity. */
export function activityEndpoint(ep: EndpointContext) {
  return queryGeneric({
    args: { threadId: v.string() },
    returns: activity,
    handler: async (ctx, args) => {
      const row = await ownedThread(ep, ctx, args.threadId, "activity");

      return ctx.runQuery(ep.component.turns.send.activity, {
        threadId: args.threadId,
        subject: row.subject,
      });
    },
  });
}

/** Return the current request's full delegation tree after root ownership authorization. */
export function runTreeEndpoint(ep: EndpointContext) {
  return queryGeneric({
    args: { threadId: v.string(), rootRunId: v.optional(v.string()) },
    returns: runTree,
    handler: async (ctx, args) => {
      const row = await ownedThread(ep, ctx, args.threadId, "activity");

      if (args.rootRunId !== undefined) assertFact(args.rootRunId, "rootRunId", "FORBIDDEN");

      const tree = await ctx.runQuery(ep.component.subagents.history.runTree, {
        ...args,
        subject: row.subject,
      });

      if (!tree) return null;

      if (ep.config.usage?.view) {
        const partial = await ctx.runQuery(ep.component.turns.slices.usageReporting, {
          runId: tree.rootRunId,
        });

        const usage = await ep.config.usage.view(ctx, {
          subject: row.subject,
          runId: tree.rootRunId,
          partial,
          nodeIds: tree.nodes.map((node) => (node.parentId === null ? null : node.id)),
        });

        const nodes = new Map(usage.nodes.map((node) => [node.nodeId, node.usage]));

        // A host view cannot erase evidence already lost by the core.
        tree.usage = { ...usage.total, reporting: partial ? "partial" : usage.total.reporting };

        for (const node of tree.nodes)
          node.usage = nodes.get(node.parentId === null ? null : node.id) ?? null;
      }

      if (valueBytes(tree) > TREE_LIMITS.outputBytes) throw new Error("RUN_TREE_TOO_LARGE");

      return tree;
    },
  });
}

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
export function delegationsEndpoint(ep: EndpointContext) {
  return queryGeneric({
    args: { threadId: v.string(), paginationOpts: paginationOptsValidator },
    returns: vPaginationResult(subagentRun),
    handler: async (ctx, args) => {
      const row = await ownedThread(ep, ctx, args.threadId, "activity");

      return ctx.runQuery(ep.component.subagents.history.delegations, {
        threadId: args.threadId,
        subject: row.subject,
        paginationOpts: args.paginationOpts,
      });
    },
  });
}
