/** Failure of the marker itself is best effort too, never a reason to repeat work. */
export async function markUsagePartial(rt, turn) {
    try {
        await turn.rawCtx.runMutation(rt.component.turns.slices.usageFailed, {
            runId: turn.facts.runId,
        });
    }
    catch {
        /* No evidence path may change the paid outcome. */
    }
}
