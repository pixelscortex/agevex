/**
 * Spending-consent tool and host orchestration for a fresh post-budget run.
 * The model requests approval; the host consumes recorded consent atomically
 * with its budget update, core cancellation and fresh send. No paid step is retried.
 */
import { defineOnceTool } from "agevex";
import { z } from "zod";
export const CONTINUE_BUDGET_LIMITS = { minChars: 1, reasonChars: 2000 };
export const CONSENT_LIMITS = { approvalIdBytes: 512, cleanupBatch: 128 };
export const continueInput = z.strictObject({
    reason: z
        .string()
        .trim()
        .min(CONTINUE_BUDGET_LIMITS.minChars)
        .max(CONTINUE_BUDGET_LIMITS.reasonChars),
});
/**
 * Model-side half: ask the user for explicit spending consent.
 *
 * ROOT ONLY. Register this tool on root agents only. Budgets, stops and the
 * resume below are all keyed to the root thread's run. If a delegated child
 * calls it anyway, the tool returns the typed `{ status: "denied", code:
 * "ROOT_ONLY" }` when it would execute. Core evaluates `needsApproval` without
 * the ToolContext (`context` is undefined there), so the child's approval
 * request cannot be suppressed before the user is asked; a user approval on a
 * child thread is harmless because the tool never records or reports consent.
 *
 * This only requests consent. It neither changes a budget nor bypasses core's
 * run limits. The native approval (answered through core `respond`) is the
 * consent record; denial never executes the tool. Core respond accepts
 * decision: { kind: "approve", edit?: { input } } or { kind: "reject", reason? };
 * host consent wrappers must check decision.kind and response.replayed. The host applies its own
 * budget policy afterwards (see `resumeAfterBudgetStop`).
 */
export function createContinueBudgetTool() {
    const approval = defineOnceTool({
        name: "continue_budget",
        input: continueInput,
        run: (input, tc) => {
            tc.signal.throwIfAborted();
            // A budget stop and its resume belong to the root thread's run. A child's
            // consent could never be spent, so refuse instead of reporting approval.
            if (tc.threadId !== tc.rootThreadId)
                return { status: "denied", code: "ROOT_ONLY" };
            return { approved: true, reason: input.reason };
        },
    });
    approval.needsApproval = true;
    approval.description =
        "Ask the user for explicit permission to spend more before the budget runs out. Approval is consent only; the host changes its budget policy separately.";
    return approval;
}
/** Model-facing consent statement placed at the start of the fresh request. */
export const CONSENT_TEXT = "The user approved continuing beyond the budget.";
/**
 * Host-side half: continue a run that core stopped with `BUDGET_EXCEEDED`.
 *
 * Core never resumes a stopped run, because the step that tripped the budget may
 * have been paid for with an unknown outcome. The only supported path is:
 *   1. explicit, single-use spending consent recorded by the host's approve action,
 *   2. the host updates its budget policy,
 *   3. cancel the stopped run (clears its recovery state and discards its notes),
 *   4. send a fresh request (a new run with its own run id).
 *
 * ATOMICITY. Call this inside ONE host mutation, with every callback made through
 * `ctx.runQuery`/`ctx.runMutation` (nested Convex calls share the caller's
 * transaction). The stop check, budget write, cancel and send then commit or roll
 * back together. Two overlapping resumes cannot both pass the stop check: the
 * loser either conflicts (OCC) and retries into `not-stopped`, or runs after the
 * winner and sees `not-stopped`. Without this, a second resume that checked the
 * stop before the first committed would cancel the fresh run the first one sent.
 *
 * REQUEST KEY. `after-budget:<threadId>:<stoppedRunId>` is unique per stop, so
 * the same thread can be stopped and resumed any number of times. A `duplicate`
 * or `rejected` receipt is never a success: `send` throws, which rolls back the
 * consent spend, the budget raise and the cancel, leaving the run resumable.
 *
 * MODEL VIEW. Cancel settles the approval call the model made as an
 * `execution-denied` tool result, because core never executes a call whose slice
 * was stopped. The fresh request therefore states the consent explicitly
 * (`CONSENT_TEXT`), so the model does not read that denial as a refusal.
 */
export async function resumeAfterBudgetStop(flow) {
    const { errorCode, runId } = await flow.activity();
    if (errorCode !== "BUDGET_EXCEEDED" || !runId)
        return { status: "not-stopped" };
    let approved = false;
    try {
        approved = await flow.consumeConsent({
            threadId: flow.threadId,
            approvalId: flow.approvalId,
            runId,
        });
    }
    catch {
        // Fail closed: an unknown, foreign or unindexable approval is not consent.
    }
    if (!approved)
        return { status: "no-consent" };
    await flow.raiseBudget();
    await flow.cancel();
    const receipt = await flow.send({
        text: flow.instruction ? `${CONSENT_TEXT} ${flow.instruction}` : CONSENT_TEXT,
        requestKey: `after-budget:${flow.threadId}:${runId}`,
    });
    // Throwing (not returning) is what rolls back the consent spend, the raise and
    // the cancel. A duplicate means this stop's key was already used for another
    // request, so no fresh run was admitted by this call.
    if (receipt.status === "rejected")
        throw new Error(receipt.code);
    if (receipt.status === "duplicate")
        throw new Error("DUPLICATE_RESUME");
    return {
        status: "resumed",
        receipt: receipt,
    };
}
