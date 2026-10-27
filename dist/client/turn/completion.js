// What happens after a clean model step: how the turn continues or ends.
//
// `completeGeneration` decides, in order: stop if the turn was fenced out; pause a
// child that asked its parent a question (`turns.slices.finish`); continue with another
// slice after undelegated tool calls (`turns.slices.continueTurn`); otherwise complete
// the turn by notifying afterTurn, and finally picks a child's result message. Called by `turn/generation.ts` inside its try, so a
// throw here is a GENERATION_FAILED / HOOK_FAILED outcome.
import {} from "../registration/context.js";
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
    await runAfterTurn(gen, turn.claimed.turn, snapshot.messageIds, result);
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
        ? async () => {
            // Notification results are ignored, including accidental JS returns.
            await managed.hooks.afterTurn(gen.hc, {
                turn: completedTurn,
                text: savedText,
                messageIds,
            });
        }
        : undefined);
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
