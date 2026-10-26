// Execution admission: the host checks that run after a claim and before any paid
// model work.
//
// `admitExecution` re-runs the host `authorizeExecution` policy with the trusted
// execution scope, then the optional budget slot. A refusal becomes the turn's
// typed error code (`AUTHORIZATION_DENIED` / `BUDGET_EXCEEDED`) and generation is
// skipped; a budget refusal also leaves the model a note through `turns.slices.write`
// → `hooks.notes.addNote` under the turn's fence.
import { createFunctionHandle } from "convex/server";
/**
 * Model-facing: a delegated child sees this at its next safe
 * claim (e.g. when descendant results arrive). Raising the
 * budget is a host decision outside the model's tools.
 */
const BUDGET_NOTE = "BUDGET_EXCEEDED: this run reached its spending budget and its last turn stopped before another model call. Finish with what you have; more spending needs the host's approval.";
/**
 * Admit one claimed turn for generation. Returns `null` when admitted, else the
 * error code the turn finishes with. Every failure mode of the host callbacks
 * (throwing included) refuses: execution is never admitted by default.
 */
export async function admitExecution(rt, turn) {
    try {
        await rt.config.authorizeExecution(turn.rawCtx, executionScope(turn));
    }
    catch {
        return "AUTHORIZATION_DENIED";
    }
    if (rt.config.budget && !(await withinBudget(rt, turn, rt.config.budget)))
        return "BUDGET_EXCEEDED";
    // Admission failure (including a full pending-note cap) preserves
    // the typed denial. Admitted notes wait for the next safe turn
    // claim; a slice boundary cannot deliver them between tool calls.
    return null;
}
/** The trusted scope `authorizeExecution` receives; every field is persisted state. */
function executionScope(turn) {
    const { claimed, child } = turn;
    return {
        subject: claimed.subject,
        agent: claimed.agent,
        assignmentId: claimed.assignmentId,
        threadId: claimed.threadId,
        turnOrigin: claimed.turnOrigin,
        child: child
            ? {
                rootAssignmentId: child.rootAssignmentId,
                rootThreadId: child.rootThreadId,
                rootAgent: child.rootAgent,
                runId: child.runId,
                actorAgent: child.actorAgent,
                childAgent: child.agent,
            }
            : undefined,
    };
}
/**
 * Ask the budget slot whether this run may spend another model call. A refusal
 * posts `BUDGET_NOTE` for the model; a throwing slot (or a failed note write)
 * still refuses.
 */
async function withinBudget(rt, turn, budget) {
    try {
        const verdict = await budget.check(turn.rawCtx, {
            subject: turn.facts.subject,
            runId: turn.facts.runId,
        });
        if (verdict.allowed)
            return true;
        await turn.rawCtx.runMutation(rt.component.turns.slices.write, {
            assignmentId: turn.claimed.assignmentId,
            executionId: turn.args.turnToken,
            cancellationEpoch: turn.claimed.cancellationEpoch,
            handle: await createFunctionHandle(rt.component.hooks.notes.addNote),
            rejectStale: true,
            args: { assignmentId: turn.claimed.assignmentId, text: BUDGET_NOTE, from: "budget" },
        });
    }
    catch {
        // Fall through: an unavailable budget slot refuses rather than spends.
    }
    return false;
}
