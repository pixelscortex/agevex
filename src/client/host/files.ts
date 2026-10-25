// Trusted host helpers for file attachments, returned by `registerAgent`.
//
// `registerFile` binds a native Agent file the host has just stored for an
// authorized subject (`files.register`); `fileAttached` is the exact attachment
// policy an extract adapter's `authorize` callback uses (`files.owns`). Neither is
// a public endpoint: they trust their caller's subject, so the host must call them
// only from its own server code after authorizing that subject.

import { createFunctionHandle } from "convex/server";
import { getConvexSize } from "convex/values";
import { assertFact } from "../../component/facts.js";
import { LIMITS } from "../../component/limits.js";
import type { CoordinatorCtx, RunnerCtx, RuntimeContext } from "../registration/context.js";

export type RegisterFileArgs = { agent: string; fileId: string; subject: string };
export type FileAttachedArgs = { threadId: string; fileId: string; subject: string };

/**
 * Trusted upload-path helper. Call after storing a file on behalf of the
 * authorized subject; never expose it as a public arbitrary-id claim.
 *
 * The native file row must exist and fit `LIMITS.fileMetadataBytes`, so later
 * attachment admission reads stay bounded.
 */
export async function registerFile(
  rt: RuntimeContext,
  ctx: CoordinatorCtx,
  args: RegisterFileArgs,
) {
  assertFact(args.subject, "subject");
  assertFact(args.agent, "agent");
  const managed = rt.graph.byName.get(args.agent);
  if (!managed) throw new Error("UNKNOWN_AGENT");

  const file = await ctx.runQuery(managed.component.files.get, { fileId: args.fileId });
  if (!file || getConvexSize(file) > LIMITS.fileMetadataBytes) throw new Error("INVALID_FILE");

  await ctx.runMutation(rt.component.files.register, {
    native: await createFunctionHandle(managed.component.files.get),
    fileId: args.fileId,
    subject: args.subject,
  });
}

/**
 * Exact attachment policy for an extract adapter's authorize callback: true only
 * when the thread belongs to `subject` and that file is attached to it.
 */
export async function fileAttached(
  rt: RuntimeContext,
  ctx: Pick<RunnerCtx, "runQuery">,
  args: FileAttachedArgs,
) {
  assertFact(args.subject, "subject");
  assertFact(args.threadId, "threadId");
  const assignment = await ctx.runQuery(rt.component.queue.assignment, {
    threadId: args.threadId,
  });
  const managed = assignment && rt.graph.byName.get(assignment.agent);
  if (!managed || assignment.subject !== args.subject) return false;

  return ctx.runQuery(rt.component.files.owns, {
    ...args,
    native: await createFunctionHandle(managed.component.files.get),
  });
}
