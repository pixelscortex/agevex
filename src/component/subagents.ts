/**
 * Registered delegation endpoints: launching, attaching, settling and
 * delivering child agent runs, plus parent/child messages and read views.
 * Entry file only: every handler delegates to a module in subagents/.
 *
 * Life of a delegation: a running turn `reserve`s a run and the host
 * `attach`es the native child thread (subagents/launch.ts); the child's turns
 * run like any other; the host `settle`s its verified result or `escalate`
 * fails it (subagents/settlement.ts, which also holds the settlement fence
 * and R3); `notify` asks the host coordinator to deliver, and `deliver` /
 * `failDelivery` record the outcome on the parent (subagents/delivery.ts).
 * Wait-"all" cohorts live in subagents/groups.ts, parent/child messages in
 * subagents/interaction.ts, read views in subagents/views.ts.
 * Tables: `subagentRuns`, `assignments`, `inbox`, `runs`.
 */
import { paginationOptsValidator } from "convex/server";
import type { FunctionReference } from "convex/server";
import { v } from "convex/values";
import { internal } from "./_generated/api.js";
import { mutation, query, internalAction, internalMutation } from "./_generated/server.js";
import { runErrorCode, subagentRun, vPaginationResult } from "./schema.js";
import { assignmentByThread } from "./queue/assignments.js";
import { runById } from "./subagents/runs.js";
import {
  attachArgs,
  attachChild,
  reservation,
  reserveArgs,
  reserveRun,
} from "./subagents/launch.js";
import { escalateRun, recordTurnOutcome } from "./subagents/settlement.js";
import { applyDelivery } from "./subagents/delivery.js";
import { releaseReadyCohort } from "./subagents/groups.js";
import {
  askParentRun,
  interactionArgs,
  interactionTarget,
  sendToChild,
} from "./subagents/interaction.js";
import {
  delegateScope,
  delegationPage,
  deliveryContextFields,
  requestTree,
  settlementScope,
  terminalContext,
} from "./subagents/views.js";

/** Trusted root context for a running turn that wants to delegate. */
export const delegateContext = query({
  args: { assignmentId: v.id("assignments"), turnToken: v.string() },
  returns: v.union(
    v.null(),
    v.object({
      rootAssignmentId: v.string(),
      rootThreadId: v.string(),
      subject: v.string(),
      rootAgent: v.string(),
      actorAgent: v.string(),
      activeRuns: v.number(),
    }),
  ),
  handler: (ctx, args) => delegateScope(ctx, args),
});

/** Admit one delegation and spend its budget; see subagents/launch.ts. */
export const reserve = mutation({
  args: reserveArgs,
  returns: reservation,
  handler: (ctx, args) => reserveRun(ctx, args),
});

/** Create the child assignment for a reserved run's native thread and queue
 * its task; see subagents/launch.ts. */
export const attach = mutation({
  args: attachArgs,
  returns: v.null(),
  handler: (ctx, args) => attachChild(ctx, args),
});

/** The host coordinator's notify entry point, typed from its opaque handle. */
function notifyReference(handle: string) {
  return handle as unknown as FunctionReference<
    "mutation",
    "internal",
    { op: "notify"; runId: string; deliveryToken: string },
    null
  >;
}

/** What a finishing child turn needs to verify and report its result: the
 * run, its recorded final message id and whether settlement is still fenced.
 * Null unless this exact token owns the running child turn of a live run;
 * see `settlementScope` in subagents/views.ts. */
export const settlementContext = query({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    runId: v.string(),
  },
  returns: v.union(
    v.null(),
    v.object({
      runId: v.string(),
      agent: v.string(),
      subject: v.string(),
      childThreadId: v.string(),
      childResultMessageId: v.union(v.string(), v.null()),
      blocked: v.boolean(),
    }),
  ),
  handler: (ctx, args) => settlementScope(ctx, args),
});

/** The coordinator's view of a terminal run it was notified about. The
 * delivery token proves the caller holds this run's delivery capability. */
export const deliveryContext = query({
  args: { runId: v.string(), deliveryToken: v.string() },
  returns: v.union(v.null(), v.object(deliveryContextFields)),
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);
    if (!run || run.deliveryToken !== args.deliveryToken) return null;

    return terminalContext(ctx, run);
  },
});

/** Record a child turn's host-verified outcome and settle its run when
 * nothing fences it; see subagents/settlement.ts. */
export const settle = mutation({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    runId: v.string(),
    childResultMessageId: v.union(v.string(), v.null()),
    errorCode: runErrorCode,
  },
  returns: v.null(),
  handler: (ctx, args) => recordTurnOutcome(ctx, args),
});

/** Fail a live run after its child turn failed terminally. */
export const escalate = internalMutation({
  args: { runId: v.string(), errorCode: v.optional(runErrorCode) },
  returns: v.null(),
  handler: (ctx, args) => escalateRun(ctx, args.runId, args.errorCode),
});

/** Ask the host coordinator to deliver a terminal run. If that call fails,
 * record a failed delivery instead; nothing is ever retried automatically. */
export const notify = internalAction({
  args: { runId: v.string(), deliveryToken: v.string(), coordinateHandle: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    try {
      await ctx.runMutation(notifyReference(args.coordinateHandle), {
        op: "notify",
        runId: args.runId,
        deliveryToken: args.deliveryToken,
      });
    } catch {
      try {
        await ctx.runMutation(internal.subagents.failDelivery, {
          runId: args.runId,
          deliveryToken: args.deliveryToken,
        });
      } catch {
        // The delivery attempt and its failure record both failed to commit.
        // Nothing is claimed here: the run stays terminal and undelivered.
      }
    }
    return null;
  },
});

/** The coordinator's delivery outcome; see subagents/delivery.ts. */
export const deliver = mutation({
  args: {
    runId: v.string(),
    deliveryToken: v.string(),
    deliveryStatus: v.union(v.literal("accepted"), v.literal("failed"), v.literal("blocked")),
    parentMessageId: v.union(v.string(), v.null()),
    errorCode: runErrorCode,
  },
  returns: v.null(),
  handler: (ctx, args) => applyDelivery(ctx, args),
});

/** notify's fallback when the coordinator itself failed. */
export const failDelivery = internalMutation({
  args: { runId: v.string(), deliveryToken: v.string() },
  returns: v.null(),
  handler: (ctx, args) =>
    applyDelivery(ctx, {
      ...args,
      deliveryStatus: "failed",
      parentMessageId: null,
      errorCode: "DELIVERY_FAILED",
    }),
});

/** Release at most one ready wait-"all" cohort of this assignment; see
 * `releaseReadyCohort` in subagents/groups.ts. */
export const releaseGroups = mutation({
  args: { assignmentId: v.id("assignments"), parentRunId: v.optional(v.id("runs")) },
  returns: v.boolean(),
  handler: (ctx, args) => releaseReadyCohort(ctx, args),
});

/** The root thread's delegation history, newest first. */
export const delegations = query({
  args: { threadId: v.string(), subject: v.string(), paginationOpts: paginationOptsValidator },
  returns: vPaginationResult(subagentRun),
  handler: async (ctx, args) => {
    const root = await assignmentByThread(ctx, args.threadId);
    if (!root || root.subject !== args.subject) throw new Error("FORBIDDEN");

    return delegationPage(ctx, root, args.paginationOpts);
  },
});

/** Trusted target projection for the host's atomic native message saves. */
export const interactionContext = query({
  args: interactionArgs,
  handler: (ctx, args) => interactionTarget(ctx, args),
});

/** The exact native follow-up id is saved in the inbox in the same transaction. */
export const messageChild = mutation({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    runId: v.string(),
    messageId: v.string(),
  },
  handler: (ctx, args) => sendToChild(ctx, args),
});

/** A child's question to its parent; see subagents/interaction.ts. */
export const askParent = mutation({
  args: {
    assignmentId: v.id("assignments"),
    turnToken: v.string(),
    questionMessageId: v.string(),
    parentMessageId: v.string(),
  },
  handler: (ctx, args) => askParentRun(ctx, args),
});

/** Only a recorded open question can be authenticated; never scan history. */
export const questionContext = query({
  args: { runId: v.string() },
  handler: async (ctx, args) => {
    const run = await runById(ctx, args.runId);
    return run?.status === "asking" ? (run.questionMessageId ?? null) : null;
  },
});

/** The current root request's delegation tree; see subagents/views.ts. */
export const runTree = query({
  args: { threadId: v.string(), subject: v.string() },
  handler: async (ctx, args) => {
    const root = await assignmentByThread(ctx, args.threadId);
    if (!root || root.subject !== args.subject || root.childRunId) throw new Error("FORBIDDEN");

    return requestTree(ctx, root);
  },
});
