/**
 * Lookups and the row builder for the `subagentRuns` table.
 *
 * One row per delegation: the child linkage, the root epoch it was admitted
 * under, its wait-"all" join state, its verified result reference, delivery
 * capability and a bounded event history. `subagents.launch.reserve` inserts it;
 * settlement, delivery and group release (subagents/*) move it forward;
 * `turns.cancel.cancel` fails every live one. All reads here are exact indexed
 * lookups; no history prefix is ever read.
 */
import type { WithoutSystemFields } from "convex/server";
import type { MutationCtx, QueryCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { LIMITS } from "../limits.js";

type SubagentRun = Doc<"subagentRuns">;

/** The run with this public run id (unique `by_run` index), or null. */
export async function runById(ctx: QueryCtx | MutationCtx, runId: string) {
  return ctx.db
    .query("subagentRuns")
    .withIndex("by_run", (q) => q.eq("runId", runId))
    .unique();
}

/** True once a run reached a terminal status. Delivery may still be pending. */
export function isSettled(status: SubagentRun["status"]) {
  return status === "completed" || status === "failed";
}

/** Append one transition, keeping only the newest `LIMITS.runEvents` so every
 * run row stays inside its <=4 KiB envelope (limits.ts cancel budget). */
export function appendEvent(
  events: SubagentRun["events"],
  phase: SubagentRun["events"][number]["phase"],
  at: number,
  errorCode: SubagentRun["errorCode"],
) {
  return [...events, { phase, at, errorCode }].slice(-LIMITS.runEvents);
}

/** One wait cohort: the members a parent launched under one run budget and
 * group name, in creation order (`by_group` pins all three fields). Callers
 * pass the cohort cap, so the read never exceeds <=15 rows (<=60 KiB). */
export function groupMembers(
  ctx: QueryCtx | MutationCtx,
  cohort: { parentRunId: Id<"runs">; actorAssignmentId: Id<"assignments">; group: string },
  limit: number,
) {
  return ctx.db
    .query("subagentRuns")
    .withIndex("by_group", (q) =>
      q
        .eq("parentRunId", cohort.parentRunId)
        .eq("actorAssignmentId", cohort.actorAssignmentId)
        .eq("group", cohort.group),
    )
    .take(limit);
}

/** The queued row `subagents.launch.reserve` inserts once admission passed. The
 * native child thread does not exist yet; `attach` adds the child linkage.
 * `wait: "all"` members start in the "open" join state, which the launching
 * slice's sealGroups later closes. */
export function newSubagentRun(fields: {
  /** The caller's reserve arguments: target agent, payload hash, coordinator. */
  request: { side?: boolean; agent: string; payloadFingerprint: string; coordinateHandle: string };
  runId: string;
  actor: Doc<"assignments">;
  root: Doc<"assignments">;
  budget: Doc<"runs">;
  depth: number;
  group: string | undefined;
  wait: "each" | "all";
  dedupKey: string;
  sequence: number;
  now: number;
}): WithoutSystemFields<SubagentRun> {
  const { request, actor, root, now } = fields;
  return {
    runId: fields.runId,
    side: request.side || undefined,
    // The root epoch this delegation belongs to; cancel bumps it to fence.
    rootCancellationEpoch: root.cancellationEpoch,
    depth: fields.depth,
    messagesReceived: 0,
    // Cohort membership (wait "all" rows carry a join state).
    group: fields.group,
    ...(fields.wait === "all" ? { join: "open" as const } : {}),
    // Budget, idempotency key and the root-wide reservation order.
    parentRunId: fields.budget._id,
    dedupKey: fields.dedupKey,
    sequence: fields.sequence,
    payloadFingerprint: request.payloadFingerprint,
    // Linkage: the root and the assignment whose turn launched this run.
    rootAssignmentId: root._id,
    actorAssignmentId: actor._id,
    agent: request.agent,
    actorAgent: actor.agent,
    // Lifecycle: queued until claim, pending delivery until settled+delivered.
    status: "queued",
    deliveryStatus: "pending",
    errorCode: null,
    // Delivery capability: the host coordinator proves it with this token.
    deliveryToken: crypto.randomUUID(),
    coordinateHandle: request.coordinateHandle,
    createdAt: now,
    events: [{ phase: "queued", at: now, errorCode: null }],
  };
}
