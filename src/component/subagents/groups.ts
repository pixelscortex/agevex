/**
 * Wait-"all" cohorts: sealing, readiness and release of joined results.
 *
 * A cohort is the set of `subagentRuns` one parent launched with the same
 * group name under one run budget. Its join state moves one way:
 * open (reserve) -> sealed (the launching slice ends, `sealGroups`) -> ready
 * (every member terminal and its delivery no longer pending: accepted, failed
 * or blocked, `markGroupReady`) -> joined (one inbox row carrying all
 * accepted results is published, `releaseGroup`). `releaseReadyCohort`
 * (`subagents.deliver.releaseGroups`) finds one ready cohort and releases it.
 * Called by turns/ slice ends (boundaries.ts, finish.ts), delivery, wake and
 * claim. Touches `subagentRuns.join`, `inbox` and the parent's counters.
 */
import type { MutationCtx } from "../_generated/server.js";
import type { Doc, Id } from "../_generated/dataModel.js";
import { groupMembers, isSettled } from "./runs.js";
import { settleIdleParent } from "./settle.js";

/** Readiness belongs to one sealed cohort, never a prefix of historical runs.
 * One representative is sufficient for indexed discovery; release marks every
 * member together. Membership is immutable after continueTurn/finish seals it.
 */
export async function markGroupReady(
  ctx: MutationCtx,
  members: Doc<"subagentRuns">[],
  root: Doc<"assignments">,
) {
  if (
    !members.length ||
    members.some(
      (member) =>
        (member.join !== "sealed" && member.join !== "ready") ||
        member.deliveryStatus === "pending" ||
        !isSettled(member.status) ||
        member.rootCancellationEpoch !== root.cancellationEpoch,
    )
  )
    return;

  // members come from one by_group range in creation order, so members[0] is
  // the same row on every call: at most one "ready" row per cohort.
  if (members[0].join === "sealed")
    await ctx.db.patch("subagentRuns", members[0]._id, { join: "ready" });
}

/** Release uses recorded parent-message ids only, regardless of queue length.
 * A joined row replaces its owed members; queue capacity must never strand
 * their already committed results. Returns true when the
 * cohort was joined (with or without a published inbox row).
 */
export async function releaseGroup(
  ctx: MutationCtx,
  parent: Doc<"assignments">,
  root: Doc<"assignments">,
  members: Doc<"subagentRuns">[],
) {
  if (
    !members.length ||
    members.some(
      (member) =>
        !member.join ||
        member.join === "open" ||
        member.deliveryStatus === "pending" ||
        !isSettled(member.status) ||
        member.rootCancellationEpoch !== root.cancellationEpoch,
    )
  )
    return false;

  if (members.some((member) => member.join === "joined")) return false;

  const accepted = members
    .filter((member) => member.deliveryStatus === "accepted" && member.resultMessageId)
    .sort((a, b) => (a.resultSequence ?? 0) - (b.resultSequence ?? 0));

  // Mark all <=15 members "joined" so the by_join fence probes retire the
  // entire cohort, including failures. No delivered body is read or copied.
  for (const member of members) await ctx.db.patch("subagentRuns", member._id, { join: "joined" });

  if (!accepted.length) return true;

  await ctx.db.insert("inbox", joinedRelease(parent, accepted, members[0].parentRunId));

  await ctx.db.patch("assignments", parent._id, {
    queuedMessages: parent.queuedMessages + 1,
    nextSequence: parent.nextSequence + 1,
  });

  return true;
}

/** The one ready inbox row a released cohort publishes. It generates from the
 * newest accepted result, while `join` keeps the earliest member's anchor so
 * claim places pending notes before every member of the batch. */
function joinedRelease(
  parent: Doc<"assignments">,
  accepted: Doc<"subagentRuns">[],
  runId: Id<"runs">,
) {
  const earliest = accepted[0];
  const newest = accepted[accepted.length - 1];

  return {
    assignmentId: parent._id,
    messageId: newest.resultMessageId!,
    join: {
      newestSequence: newest.resultSequence!,
      earliestId: earliest.resultMessageId!,
      earliestSequence: earliest.resultSequence!,
    },
    sequence: parent.nextSequence,
    // A joined release carries delegated results. Labelling it "note" made
    // hooks.origins.origins report the newest member's result as an origin-less note
    // while the release was queued; wake and claim treat "result" and "note"
    // identically, so only the label changes.
    kind: "result" as const,
    runId,
  };
}

/** A fast child may settle between two tool calls in the same model slice.
 * Seal only at that slice's existing completion mutation, never at settlement.
 * There is only one running slice per assignment; all unsealed members of its
 * current run belong to it. <=50 launch rows *4 KiB plus <=50 patch reads
 * =400 KiB, <=100 reads/50 writes. The index excludes older request budgets
 * and already sealed cohorts; no transcript or Workflow journal is consulted.
 *
 * The range also pins the root's CURRENT epoch. That excludes nothing: an open
 * member from an older epoch can never share parent.runId with a running
 * parent. A cancel that bumps the epoch while a member of run R is still open
 * finds R either as root.runId (the root stays on R until a slice end seals R's
 * members: approval pauses and recovery_required both keep runId) or as the
 * runId of the member's still-active actor, and marks R cancelled; it also
 * idles that actor and deletes its ready inbox rows. Afterwards every path
 * that could enqueue ready work for R is fenced (reserve/continueAdmission by
 * R.cancelled; attach, delivery, post and release by the epoch), so no
 * assignment runs under R again and reserve refuses any new member of R.
 */
export async function sealGroups(ctx: MutationCtx, parent: Doc<"assignments">) {
  if (!parent.runId) return;

  const root = parent.rootAssignmentId
    ? await ctx.db.get("assignments", parent.rootAssignmentId)
    : parent;

  if (!root) return;

  const members = await ctx.db
    .query("subagentRuns")
    .withIndex("by_join", (q) =>
      q
        .eq("actorAssignmentId", parent._id)
        .eq("rootCancellationEpoch", root.cancellationEpoch)
        .eq("join", "open")
        .eq("parentRunId", parent.runId!),
    )
    .take(parent.limits.runLaunches);

  for (const member of members) {
    await ctx.db.patch("subagentRuns", member._id, { join: "sealed" });
    member.join = "sealed";
  }

  const groups = new Set(members.map((member) => member.group ?? ""));

  // Partition the <=50 just-sealed rows in memory; no repeated group queries.
  for (const group of groups)
    await markGroupReady(
      ctx,
      members.filter((member) => (member.group ?? "") === group),
      root,
    );
}

/** Ready-group recovery uses an exact indexed representative, then only that
 * cohort's <=15 members (<=64 KiB + fixed assignment metadata). Old incomplete
 * groups never enter this range. Release one cohort per wake; remaining ready
 * cohorts are serviced by the next claim/finish without a scheduled sweep.
 * `parentRunId` restricts the search to one run (claim's same-run merge).
 * Returns true when a cohort was released. */
export async function releaseReadyCohort(
  ctx: MutationCtx,
  args: { assignmentId: Id<"assignments">; parentRunId?: Id<"runs"> },
) {
  const parent = await ctx.db.get("assignments", args.assignmentId);

  if (!parent || parent.cancelled) return false;

  const root = parent.rootAssignmentId
    ? await ctx.db.get("assignments", parent.rootAssignmentId)
    : parent;

  if (!root || root.cancelled) return false;

  const candidate = await ctx.db
    .query("subagentRuns")
    .withIndex("by_join", (q) => {
      const ready = q
        .eq("actorAssignmentId", parent._id)
        .eq("rootCancellationEpoch", root.cancellationEpoch)
        .eq("join", "ready");

      return args.parentRunId ? ready.eq("parentRunId", args.parentRunId) : ready;
    })
    .first();

  if (!candidate) return false;

  const members = await groupMembers(
    ctx,
    {
      parentRunId: candidate.parentRunId,
      actorAssignmentId: parent._id,
      group: candidate.group ?? "",
    },
    root.limits.activeChildrenPerRoot,
  );

  const released = await releaseGroup(ctx, parent, root, members);

  if (released) await settleIdleParent(ctx, (await ctx.db.get("assignments", parent._id))!);

  return released;
}
