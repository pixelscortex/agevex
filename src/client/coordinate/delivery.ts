// Delivery of a settled child run to its parent conversation.
//
// After a child turn settles its run, the runner calls `deliverTerminalRun`, which
// invokes the coordinator's `notify` op; that op loads the trusted delivery
// context (`subagents.deliver.deliveryContext`) and makes the single bounded
// `attemptDelivery`. Delivery verifies the child result, re-authorizes with the
// host `deliver` policy, then saves the parent notification and records its outcome through
// `subagents.deliver.deliver`. Settlement itself lives in `settle.ts`.

import { saveMessage } from "@convex-dev/agent";
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

  const text = await deliveryText(rt, ctx, context, record);

  if (text === null) return null;

  const root = rt.graph.byName.get(context.parentAgent);

  if (!root) return blockDelivery(rt, ctx, context, record, "ROOT_UNAVAILABLE");

  if (!(await deliveryAuthorized(rt, ctx, context)))
    return blockDelivery(rt, ctx, context, record, "AUTHORIZATION_DENIED");

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
 * run delivers a fixed sanitized failure line.
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

    return `${context.agent} completed the delegated task.\n\n${verified}`;
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

/** Save the parent notification and record its exact id with the acceptance. */
async function deliverParentMessage(
  rt: RuntimeContext,
  ctx: CoordinatorCtx,
  context: DeliveryContext,
  record: RecordDelivery,
  root: ManagedAgent,
  text: string,
): Promise<null> {
  const { messageId } = await saveMessage(ctx, root.component, {
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
 * is never attempted twice.
 *
 * If that failure record also cannot commit, no delivery attempt is in flight
 * any more, so ONE more best-effort call records `failed` / `DELIVERY_UNKNOWN`
 * (same token, same pending compare-and-set) and cannot drop a result that
 * would otherwise arrive. Without it the run would stay `pending`, holding one
 * of the parent's cross-request result slots (`canOweResult`) and a hop.
 * `DELIVERY_UNKNOWN` is a separate code because the outcome really is unknown,
 * not a known failure. If this last write throws too it is swallowed: the run
 * stays `pending` and only a cancel (an epoch bump, which the slot guard
 * counts) clears it. Nothing is ever retried.
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
    await recordFailure(rt, ctx, runId, deliveryToken);
  }
}

/** Record `DELIVERY_FAILED`, then `DELIVERY_UNKNOWN` if that throws; see
 * `deliverTerminalRun`. The last write's error is swallowed on purpose. */
async function recordFailure(
  rt: RuntimeContext,
  ctx: RunnerCtx,
  runId: string,
  deliveryToken: string,
): Promise<void> {
  const failed = (errorCode: "DELIVERY_FAILED" | "DELIVERY_UNKNOWN") =>
    ctx.runMutation(rt.component.subagents.deliver.deliver, {
      runId,
      deliveryToken,
      deliveryStatus: "failed",
      parentMessageId: null,
      errorCode,
    });

  try {
    await failed("DELIVERY_FAILED");
  } catch {
    try {
      await failed("DELIVERY_UNKNOWN");
    } catch {
      // All three writes failed to commit; nothing is claimed about a
      // delivery that did not happen. Only a cancel clears this row.
    }
  }
}
