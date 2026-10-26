import { resolveRunSettings } from "../run-settings.js";
import { finishTurn } from "./finish.js";
import { settleRouting } from "../hooks/routing.js";
import { sealGroups } from "../subagents/groups.js";
import { cancelIfPending } from "./recovery.js";
import { wake } from "./wake.js";
/** Close the in-flight slice: release routing ownership and retire its
 * watchdog. Leaves `turnStatus` alone, so a running turn without a watchdog
 * reads as "between slices". */
export async function disarmSlice(ctx, row) {
    // Every terminal fence, including watchdog/cancel and native approval exits,
    // releases routing even if the action never reaches its finally block.
    await settleRouting(ctx, row);
    // A watchdog firing now already owns its scheduled job. Clear the slice
    // fence without attempting to cancel that in-progress detector itself.
    if (row.watchdogId)
        await cancelIfPending(ctx, row.watchdogId);
    await ctx.db.patch("assignments", row._id, { watchdogId: undefined, activeTools: undefined });
}
/** The host action finished one slice and will run another: close the slice
 * (the turn stays running), seal its cohorts and publish released results. */
export async function closeSlice(ctx, args) {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row ||
        row.cancelled ||
        row.turnToken !== args.executionId ||
        row.cancellationEpoch !== args.cancellationEpoch ||
        row.turnStatus !== "running")
        return null;
    // Disarming the slice's watchdog while the turn stays running is what
    // marks it between slices (claim and betweenSlices read that pair).
    // Keep the claimed ready-work prompt as the generation boundary across
    // slices. Native Agent includes the whole response order, including
    // tool results, notes and continuation prompts in stepOrder chronology.
    await disarmSlice(ctx, row);
    await sealGroups(ctx, row);
    // Release sealed results inside this existing step; v1's positional
    // Workflow sequence remains untouched. A running slice cannot be claimed
    // again by wake, so its normal between-slice continuation still owns it.
    await wake(ctx, { ...row, watchdogId: undefined });
    return null;
}
/** Phase 1c's seam: all between-slice state checks belong here. Returns the
 * token to run another slice, or null to end the turn workflow (stale,
 * cancelled, a slice that never reached continueTurn, or a cancelled run). */
export async function admitNextSlice(ctx, args) {
    const row = await ctx.db.get("assignments", args.assignmentId);
    if (!row ||
        row.cancelled ||
        row.turnToken !== args.executionId ||
        row.turnStatus !== "running" ||
        // An armed watchdog means the slice never reached continueTurn.
        row.watchdogId)
        return null;
    await disarmSlice(ctx, row);
    const run = row.runId ? await ctx.db.get("runs", row.runId) : null;
    if (!run || run.cancelled)
        return null;
    const settings = run.settings?.find((entry) => entry.agent === row.agent)?.settings ?? resolveRunSettings();
    if ((row.modelSteps ?? 0) >= settings.stepsPerTurn) {
        await finishTurn(ctx, {
            assignmentId: row._id,
            turnToken: args.executionId,
            errorCode: "SLICE_LIMIT",
        });
        return null;
    }
    // Exhausting delegation budget never prevents a final answer. Admission of
    // additional effects checks launches/hops transactionally in reserve.
    if (run.launches > row.limits.runLaunches || run.hops > row.limits.runHops)
        throw new Error("RUN_BUDGET");
    return args.executionId;
}
