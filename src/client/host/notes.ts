// Trusted host helpers that post notes into a managed thread, returned by
// `registerAgent`.
//
// `note` lets host code add a note for the thread's next turn after the host
// `note` policy authorizes the current caller; `sandboxComplete` turns a sandbox
// job completion into a bounded note after the host `sandbox` policy re-checks the
// stored owner. Both read `queue.assignment` and admit through `hooks.addNote`
// (via `postNote`), which holds the note until the next safe turn claim.

import { assertFact } from "../../component/facts.js";
import { LIMITS } from "../../component/limits.js";
import { postNote, type NoteArgs } from "../hooks.js";
import type { CoordinatorCtx, RuntimeContext } from "../registration/context.js";

/** A sandbox job's terminal report, delivered by the sandbox module's callback. */
export type SandboxCompletion = {
  subject: string;
  threadId: string;
  runId: string;
  jobId: string;
  state: "done" | "failed" | "unknown";
  exitCode?: number;
  logTail?: string;
};

/**
 * Post one sandbox completion as a note on the managed thread that started it.
 *
 * Throws `FORBIDDEN` unless the sandbox slot is configured, the thread is managed
 * by this registration, the stored owner matches, and the host `sandbox` policy
 * returns that same owner; throws `INVALID_SANDBOX_COMPLETION` for an
 * out-of-bounds report. Returns whether the note was admitted.
 */
export async function sandboxComplete(
  rt: RuntimeContext,
  ctx: CoordinatorCtx,
  event: SandboxCompletion,
) {
  assertFact(event.subject, "subject");
  assertFact(event.threadId, "threadId");
  assertFact(event.runId, "runId");
  const assignment = await ctx.runQuery(rt.component.queue.assignment, {
    threadId: event.threadId,
  });
  const managed = assignment && rt.graph.byName.get(assignment.agent);
  // Any managed thread of this registration may receive a completion: a
  // job started by an opted-in child reports to its root conversation,
  // whose own agent need not use sandbox tools. The trust gate is the
  // configured slot, the stored owner and the host's `sandbox` authorize.
  if (!assignment || !managed || !rt.config.sandbox || assignment.subject !== event.subject)
    throw new Error("FORBIDDEN");

  const { subject } = await rt.config.authorize(ctx, {
    operation: "sandbox",
    agent: managed.name,
    threadId: event.threadId,
    subject: assignment.subject,
    runId: event.runId,
  });
  if (subject !== assignment.subject) throw new Error("FORBIDDEN");
  if (!validSandboxCompletion(event)) throw new Error("INVALID_SANDBOX_COMPLETION");

  return postNote(ctx, rt.component, assignment.assignmentId, {
    threadId: event.threadId,
    from: "sandbox",
    text: sandboxNoteText(event),
  });
}

/** Exit code, run id, job id and state must all fit their stored bounds. */
function validSandboxCompletion(event: SandboxCompletion): boolean {
  return !(
    (event.exitCode !== undefined &&
      (!Number.isSafeInteger(event.exitCode) ||
        Math.abs(event.exitCode) > LIMITS.sandboxExitCode)) ||
    !event.runId ||
    event.runId.length > LIMITS.requestKeyLength ||
    !event.jobId ||
    event.jobId.length > LIMITS.requestKeyLength ||
    !["done", "failed", "unknown"].includes(event.state)
  );
}

/** One-line job status plus the log tail, clipped to `LIMITS.noteLength`. */
function sandboxNoteText(event: SandboxCompletion): string {
  const exit = event.exitCode === undefined ? "" : ` (exit ${event.exitCode})`;
  return `Job ${event.jobId}: ${event.state}${exit}\n${event.logTail ?? ""}`.slice(
    0,
    LIMITS.noteLength,
  );
}

/**
 * Host-posted note for a managed thread's next turn.
 *
 * The thread must be managed, the host `note` policy must return a subject, and
 * that subject must own the thread; otherwise `FORBIDDEN`. Returns whether the
 * note was admitted (a full pending-note cap refuses it).
 */
export async function note(
  rt: RuntimeContext,
  ctx: CoordinatorCtx,
  args: NoteArgs,
): Promise<boolean> {
  assertFact(args.threadId, "threadId");
  const scope = await ctx.runQuery(rt.component.queue.assignment, { threadId: args.threadId });
  if (!scope) throw new Error("FORBIDDEN");

  const { subject } = await rt.config.authorize(ctx, {
    operation: "note",
    agent: scope.agent,
    threadId: args.threadId,
  });
  assertFact(subject, "subject");
  const owned = scope.subject === subject ? scope : null;
  const managed = rt.graph.byName.get(scope.agent);
  if (!owned || !managed) throw new Error("FORBIDDEN");

  return postNote(ctx, rt.component, owned.assignmentId, args);
}
