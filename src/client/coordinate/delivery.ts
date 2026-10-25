// Delivery of a settled child run to its parent conversation.
//
// After a child turn settles its run, the runner calls `deliverTerminalRun`, which
// invokes the coordinator's `notify` op; that op loads the trusted delivery
// context (`subagents.deliver.deliveryContext`) and makes the single bounded
// `attemptDelivery`. Delivery verifies the child result, re-authorizes with the
// host `deliver` policy, then either saves the parent notification (normal child)
// or posts a note (side agent), and always records the outcome through
// `subagents.deliver.deliver`. Settlement itself lives in `settle.ts`.

import { LIMITS } from "../../component/limits.js";
import { postNote } from "../host/notes.js";
import { saveTrackedMessage } from "../native-saves.js";
import {
  observe,
  type CoordinatorCtx,
  type RunnerCtx,
  type RuntimeContext,
} from "../registration/context.js";
import type { ManagedAgent, RunErrorCode } from "../types.js";
import { verifyChildMessage } from "./verify.js";

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

/** Records one delivery outcome with the run's one-shot delivery capability. */
type RecordDelivery = (
  deliveryStatus: "accepted" | "failed" | "blocked",
  code: RunErrorCode,
  parentMessageId?: string | null,
) => Promise<unknown>;

/**
 * Coordinator `notify` op: load the trusted delivery context for this one-shot
 * capability and attempt delivery. A stale or already-used token loads nothing
 * and is a no-op, which is what makes delivery at-most-once.
 */
export async function notifyRun(
  rt: RuntimeContext,
  ctx: CoordinatorCtx,
  args: { runId: string; deliveryToken: string },
): Promise<null> {
  const context = await ctx.runQuery(rt.component.subagents.deliver.deliveryContext, {
    runId: args.runId,
    deliveryToken: args.deliveryToken,
  });
  if (!context) return null;

  return attemptDelivery(rt, ctx, context, args.deliveryToken);
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
  rt: RuntimeContext,
  ctx: CoordinatorCtx,
  context: DeliveryContext,
  deliveryToken: string,
): Promise<null> {
  const record: RecordDelivery = (deliveryStatus, code, parentMessageId = null) =>
    ctx.runMutation(rt.component.subagents.deliver.deliver, {
      runId: context.runId,
      deliveryToken,
      deliveryStatus,
      parentMessageId,
      errorCode: code,
    });

  if (!context.rootAvailable) return blockDelivery(rt, ctx, context, record, "ROOT_UNAVAILABLE");
  if (context.side && context.status === "failed" && context.errorCode === "EMPTY_RESULT") {
    await record("failed", context.errorCode);
    return null;
  }

  const text = await deliveryText(rt, ctx, context, record);
  if (text === null) return null;

  const root = rt.graph.byName.get(context.parentAgent);
  if (!root) return blockDelivery(rt, ctx, context, record, "ROOT_UNAVAILABLE");
  if (!(await deliveryAuthorized(rt, ctx, context)))
    return blockDelivery(rt, ctx, context, record, "AUTHORIZATION_DENIED");

  if (context.side) return deliverSideNote(rt, ctx, context, record, text);
  return deliverParentMessage(rt, ctx, context, record, root, text);
}

/** Record a `blocked` delivery (no native write happened) and report it. */
async function blockDelivery(
  rt: RuntimeContext,
  ctx: CoordinatorCtx,
  context: DeliveryContext,
  record: RecordDelivery,
  code: "ROOT_UNAVAILABLE" | "AUTHORIZATION_DENIED",
): Promise<null> {
  await record("blocked", code);
  await observeDelivered(rt, ctx, context, "blocked");
  return null;
}

/**
 * The text a delivery would post, or `null` once a failure has been recorded.
 *
 * A completed run's result must verify against the child transcript; an
 * unverified result records `RESULT_UNVERIFIED` and is never delivered. A failed
 * run delivers a fixed sanitized failure line (side agents deliver nothing).
 */
async function deliveryText(
  rt: RuntimeContext,
  ctx: CoordinatorCtx,
  context: DeliveryContext,
  record: RecordDelivery,
): Promise<string | null> {
  if (context.status === "completed") {
    const verified = context.childResultMessageId
      ? await verifyChildMessage(rt, ctx, {
          threadId: context.childThreadId,
          agentName: context.agent,
          messageId: context.childResultMessageId,
          subject: context.subject,
        })
      : null;
    if (!verified) {
      await record("failed", "RESULT_UNVERIFIED");
      await observeDelivered(rt, ctx, context, "failed");
      return null;
    }
    return context.side
      ? verified
      : `${context.agent} completed the delegated task.\n\n${verified}`;
  }

  if (context.side) {
    await record("failed", context.errorCode);
    return null;
  }
  return `${context.agent} failed the delegated task (${
    context.errorCode ?? "GENERATION_FAILED"
  }). No result was accepted.`;
}

/**
 * Re-run the host `deliver` policy with trusted persisted identities. A throw
 * or a different subject both deny: delivery never trusts a stale grant.
 */
async function deliveryAuthorized(
  rt: RuntimeContext,
  ctx: CoordinatorCtx,
  context: DeliveryContext,
): Promise<boolean> {
  let subject = "";
  try {
    ({ subject } = await rt.config.authorize(ctx, {
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
  return !!subject && subject === context.subject;
}

/**
 * A side agent's result becomes a bounded note on the watched thread, posted
 * only when it says something (`NONE` means nothing to add). A refused note
 * (for example a full pending-note cap) records `DELIVERY_FAILED`.
 */
async function deliverSideNote(
  rt: RuntimeContext,
  ctx: CoordinatorCtx,
  context: DeliveryContext,
  record: RecordDelivery,
  text: string,
): Promise<null> {
  if (text.trim() && text.trim() !== "NONE") {
    const row = await ctx.runQuery(rt.component.turns.send.assignment, {
      threadId: context.parentThreadId,
    });
    const accepted =
      row &&
      (await postNote(ctx, rt.component, row.assignmentId, {
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

/** Save the parent notification and record its exact id with the acceptance. */
async function deliverParentMessage(
  rt: RuntimeContext,
  ctx: CoordinatorCtx,
  context: DeliveryContext,
  record: RecordDelivery,
  root: ManagedAgent,
  text: string,
): Promise<null> {
  const { messageId } = await saveTrackedMessage(rt, ctx, root.component, {
    threadId: context.parentThreadId,
    prompt: text,
    userId: context.subject,
    agentName: context.agent,
  });
  await record("accepted", null, messageId);
  await observeDelivered(rt, ctx, context, "accepted");
  return null;
}

function observeDelivered(
  rt: RuntimeContext,
  ctx: CoordinatorCtx,
  context: DeliveryContext,
  outcome: "accepted" | "failed" | "blocked",
) {
  return observe(rt, ctx, {
    type: "delegation.delivered",
    runId: context.runId,
    rootAssignmentId: context.rootAssignmentId,
    agent: context.agent,
    outcome,
  });
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
export async function deliverTerminalRun(
  rt: RuntimeContext,
  ctx: RunnerCtx,
  runId: string,
  deliveryToken: string,
): Promise<void> {
  try {
    // `refs.coordinate` is required whenever collaboration is configured, and
    // this path is only reachable from a child turn of such a registration.
    await ctx.runMutation(rt.config.refs.coordinate!(), { op: "notify", runId, deliveryToken });
  } catch {
    try {
      await ctx.runMutation(rt.component.subagents.deliver.deliver, {
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
