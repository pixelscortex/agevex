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
 *   message, with the server-derived thread owner. Core has already proven
 *   (atomically with saving the message) that the subject owns every file, so
 *   this is only an admission request. The module's own admission
 *   (`artifacts.admit`: reuse | wait | run) is the sole deduplication: a
 *   replayed slice, a retried send or the same file attached to a later message
 *   returns `reuse`/`wait` and never starts paid work twice. The subject rides
 *   in the durable job's arguments so the background worker, which has no
 *   session, can authorize without looking anything up.
 * - `tools`: per slice, bound to the running thread and subject. The tools are
 *   the module's own `read_file` (and `search_files` when RAG is configured).
 *   The thread and subject come from the server-built `ToolContext`, never from
 *   model input, so the model cannot name another thread to read.
 *
 * Authorization is the host's `authorize` callback on `defineExtract`; see
 * `authorizeAttached` below for the agevex implementation.
 */
export function extractSlot(api: {
  run(
    ctx: ActionCtx,
    args: { threadId: string; fileId: string; subject: string },
  ): Promise<unknown>;
  tools(context: { ctx: ActionCtx; threadId: string; subject: string }): ToolSet;
}): ExtractSlot {
  return {
    run: (ctx: SlotActionCtx, args) =>
      api.run(ctx, { threadId: args.threadId, fileId: args.fileId, subject: args.subject }),
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

/**
 * Build the `authorize` callback of `defineExtract` for agevex-managed threads.
 *
 * ```ts
 * authorize: authorizeAttached(() => runtime)
 * ```
 *
 * `runtime` is passed lazily because `registerAgent({ extract: extract.slot() })`
 * and `defineExtract({ authorize })` reference each other.
 *
 * Every file operation (`run`, `get`, reads, the worker's `execute`) must carry
 * the thread owner and pass `runtime.fileAttached(subject, threadId, fileId)`,
 * an indexed exact-attachment lookup that also checks the thread belongs to
 * that subject. A call without a subject is denied.
 *
 * Operations without a file (`search`, `index`) are allowed only for the
 * subject-bound slot tools' own namespace, which is the thread id. They read no
 * file by themselves: search rechecks every hit's file, and index loads its
 * artifact through the file check above. Everything else, such as `fromUrl`,
 * is denied: write your own `authorize` if you need it.
 */
export function authorizeAttached(runtime: () => AttachmentRuntime): ExtractOptions["authorize"] {
  return async (ctx, scope) => {
    if (scope.subject === undefined) throw new Error("FORBIDDEN");
    if (scope.fileId === undefined) {
      if (
        (scope.operation !== "search" && scope.operation !== "index") ||
        scope.namespace !== scope.threadId
      )
        throw new Error("FORBIDDEN");
      return;
    }
    if (
      !(await runtime().fileAttached(ctx, {
        threadId: scope.threadId,
        fileId: scope.fileId,
        subject: scope.subject,
      }))
    )
      throw new Error("FORBIDDEN");
  };
}
