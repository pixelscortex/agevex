// What happens after a clean model step: how the turn continues or ends.
//
// `completeGeneration` decides, in order: stop if the turn was fenced out; pause a
// child that asked its parent a question (`turns.slices.finish`); continue with another
// slice after undelegated tool calls (`turns.slices.continueTurn`); otherwise complete
// the turn (`hooks.state.hookState`), run `afterTurn`, launch side reviews, admit an
// `afterTurn` continuation (`hooks.state.continueAdmission`), and finally pick a
// child's result message. Called by `turn/generation.ts` inside its try, so a
// throw here is a GENERATION_FAILED / HOOK_FAILED outcome.
import { coordinateRef } from "../registration/context.js";
import { stillOwns } from "./context.js";
/**
 * Apply the post-step decisions. Returns `null` when the turn has been handed on
 * (fenced out, paused or continued), else the successful outcome to finalize.
 */
export async function completeGeneration(rt, gen, result, reason) {
    const { turn, fence, state } = gen;
    const { args, child } = turn;
    const snapshot = await turn.rawCtx.runQuery(rt.component.turns.slices.execution, {
        assignmentId: args.assignmentId,
    });
    if (!stillOwns(snapshot, turn))
        return null;
    if (state.budgetExceeded)
        return { errorCode: "BUDGET_EXCEEDED", childError: "BUDGET_EXCEEDED" };
    if (child && state.asked) {
        await fence.ctx.runMutation(rt.component.turns.slices.finish, {
            assignmentId: args.assignmentId,
            turnToken: args.turnToken,
            errorCode: null,
        });
        return null;
    }
    if (reason === "tool-calls" &&
        !state.delegated &&
        (await continueAfterToolCalls(rt, turn, result)))
        return null;
    const completed = await fence.ctx.runMutation(rt.component.hooks.state.hookState, {
        assignmentId: turn.claimed.assignmentId,
        executionId: args.turnToken,
        complete: true,
    });
    const after = await runAfterTurn(gen, completed.turn, completed.messageIds, result);
    await launchSideReviews(rt, gen, completed.turn);
    if (await continueFromHook(rt, gen, after))
        return null;
    return { errorCode: null, ...childResult(turn, result) };
}
/** Successful assistant messages the step saved, in order. */
function savedAssistantMessages(result) {
    return (result.savedMessages ?? []).filter((message) => message.message?.role === "assistant" && message.status === "success");
}
/**
 * Tool calls without a delegation continue in a new slice from the last saved
 * message. Returns false when the step saved nothing to continue from.
 */
async function continueAfterToolCalls(rt, turn, result) {
    const last = result.savedMessages?.[result.savedMessages.length - 1];
    if (!last)
        return false;
    await turn.rawCtx.runMutation(rt.component.turns.slices.continueTurn, {
        assignmentId: turn.args.assignmentId,
        executionId: turn.args.turnToken,
        cancellationEpoch: turn.claimed.cancellationEpoch,
        messageId: String(last._id),
    });
    return true;
}
/** Report all committed assistant ids in this reporting turn. Text retains its
 * existing final-slice semantics: successful assistant text joined by newlines.
 * Earlier tool narration can be read by exact id without enlarging assignment
 * rows with response content. Approval pauses emit no event until completion.
 */
function runAfterTurn(gen, completedTurn, messageIds, result) {
    const { managed } = gen.turn;
    const savedText = savedAssistantMessages(result)
        .map((message) => message.text ?? "")
        .join("\n");
    return gen.hook(managed.hooks?.afterTurn
        ? () => managed.hooks.afterTurn(gen.hc, { turn: completedTurn, text: savedText, messageIds })
        : undefined);
}
/**
 * Launch every side agent's review of this turn.
 *
 * A side review is best effort, independently admitted and never
 * awaited as a workflow/child result. Only its short launch mutation
 * is awaited here; paid child work is dispatched on the child lane.
 * The tool call id is keyed by the completed turn, so a replay is idempotent.
 */
async function launchSideReviews(rt, gen, completedTurn) {
    const { turn, fence } = gen;
    for (const side of turn.managed.sideAgents ?? []) {
        try {
            await fence.ctx.runMutation(coordinateRef(rt), {
                op: "launch",
                side: true,
                assignmentId: turn.claimed.assignmentId,
                turnToken: turn.args.turnToken,
                toolCallId: `side:${side.agent.name}:${completedTurn}`,
                agent: side.agent.name,
                task: "Review the following conversation delta. Reply with a short helpful note, or NONE if there is nothing to add.",
            });
        }
        catch {
            /* Side review failures never fail the watched turn. */
        }
    }
}
/**
 * Admit an `afterTurn` continuation prompt and continue the turn with it.
 * Returns false when there is no continuation or admission refused it.
 */
async function continueFromHook(rt, gen, after) {
    const { turn, fence } = gen;
    const continuation = after?.continue
        ? await fence.ctx.runMutation(rt.component.hooks.state.continueAdmission, {
            assignmentId: turn.claimed.assignmentId,
            executionId: turn.args.turnToken,
            prompt: after.continue,
        })
        : null;
    if (!continuation)
        return false;
    await fence.ctx.runMutation(rt.component.turns.slices.continueTurn, {
        assignmentId: turn.claimed.assignmentId,
        executionId: turn.args.turnToken,
        cancellationEpoch: turn.claimed.cancellationEpoch,
        messageId: continuation,
    });
    return true;
}
/**
 * A child turn's result candidate.
 *
 * Native final saves have completed. A child result must be a
 * saved, non-empty assistant text message; tool-only or empty
 * output is a failed run, never a delivered result. The id is verified
 * against the transcript again at settlement (`coordinate/settle.ts`).
 */
function childResult(turn, result) {
    if (!turn.child)
        return { childError: null };
    const saved = savedAssistantMessages(result);
    const final = saved[saved.length - 1];
    if (!final?.text || !final.text.trim())
        return { childError: "EMPTY_RESULT" };
    return { childError: null, childResultMessageId: String(final._id) };
}
