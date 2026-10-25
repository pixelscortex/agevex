import type { FunctionReference } from "convex/server";
import type { ToolSet } from "ai";
import type { ExtractSlot, SlotActionCtx } from "../client/slots.js";
import type { ToolContext } from "../client/once.js";
import type { ExtractOptions, ActionCtx } from "./types.js";

/**
 * agevex adapter for the `extract` slot.
 *
 * Core never imports this module: it only knows the `ExtractSlot` contract
 * (`src/client/slots.ts`) and calls it at two points of a managed turn.
 *
 * - `run`: at the first slice of a turn, once per file attached to that user
 *   message. Core has already proven (atomically with saving the message) that
 *   the subject owns every file, so this is only an admission request. The
 *   module's own admission (`artifacts.admit`: reuse | wait | run) is the sole
 *   deduplication: a replayed slice, a retried send or the same file attached
 *   to a later message returns `reuse`/`wait` and never starts paid work twice.
 *   Core does not retry it and never reads the module's state.
 * - `tools`: per slice, bound to the running thread and subject. The tools are
 *   the module's own `read_file` (and `search_files` when RAG is configured).
 *   The thread and subject come from the server-built `ToolContext`, never from
 *   model input, so the model cannot name another thread to read.
 *
 * Authorization is the host's `authorize` callback on `defineExtract`; see
 * `authorizeAttached` below for the agevex implementation.
 */
export function extractSlot(api: {
  run(ctx: ActionCtx, args: { threadId: string; fileId: string }): Promise<unknown>;
  tools(context: { ctx: ActionCtx; threadId: string; subject: string }): ToolSet;
}): ExtractSlot {
  return {
    run: (ctx: SlotActionCtx, args) =>
      api.run(ctx, { threadId: args.threadId, fileId: args.fileId }),
    tools: (context: ToolContext) =>
      api.tools({ ctx: context.ctx, threadId: context.threadId, subject: context.subject }),
  };
}

/** The part of the agevex runtime the attachment policy needs. */
type AttachmentRuntime = {
  fileAttached(
    ctx: ActionCtx,
    args: { threadId: string; fileId: string; subject: string },
  ): Promise<boolean>;
};
/** The part of the mounted agevex component used to resolve a thread's owner. */
type ThreadOwners = {
  queue: {
    assignment: FunctionReference<
      "query",
      "internal",
      { threadId: string },
      { subject: string } | null
    >;
  };
};

/**
 * Build the `authorize` callback of `defineExtract` for agevex-managed threads.
 *
 * ```ts
 * authorize: authorizeAttached(() => runtime, components.agevex)
 * ```
 *
 * `runtime` is passed lazily because `registerAgent({ extract: extract.slot() })`
 * and `defineExtract({ authorize })` reference each other.
 *
 * Why the subject lookup exists: the tools know their subject, but the durable
 * worker (`execute`) and core's `run` have no user session and no subject. The
 * thread's assignment is the only server-side record of its owner, so the owner
 * is read from it (one indexed read) rather than copied into extraction rows.
 * `runtime.fileAttached` then proves the exact thread-bound attachment with an
 * indexed lookup; it never scans messages.
 *
 * Fail-closed rules:
 * - file operations require `runtime.fileAttached(subject, threadId, fileId)`;
 * - thread-level operations (index/search/fromUrl) require a caller-supplied
 *   subject that owns the thread, and namespaces must equal the thread id, which
 *   is the only namespace the slot's `search_files` uses.
 */
export function authorizeAttached(
  runtime: () => AttachmentRuntime,
  core: ThreadOwners,
): ExtractOptions["authorize"] {
  return async (ctx, scope) => {
    const owner = (await ctx.runQuery(core.queue.assignment, { threadId: scope.threadId }))
      ?.subject;
    if (!owner || (scope.subject !== undefined && scope.subject !== owner))
      throw new Error("FORBIDDEN");
    if (scope.fileId === undefined) {
      if (scope.subject === undefined || (scope.namespace ?? scope.threadId) !== scope.threadId)
        throw new Error("FORBIDDEN");
      return;
    }
    if (
      !(await runtime().fileAttached(ctx, {
        threadId: scope.threadId,
        fileId: scope.fileId,
        subject: owner,
      }))
    )
      throw new Error("FORBIDDEN");
  };
}
