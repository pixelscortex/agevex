import { z } from "zod";
export declare const CONTINUE_BUDGET_LIMITS: {
    readonly minChars: 1;
    readonly reasonChars: 2000;
};
export declare const CONSENT_LIMITS: {
    readonly approvalIdBytes: 512;
    readonly cleanupBatch: 128;
};
export declare const continueInput: z.ZodObject<{
    reason: z.ZodString;
}, z.core.$strict>;
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
export declare function createContinueBudgetTool(): import("ai").Tool<{
    reason: string;
}, {
    status: string;
    code: string;
    approved?: undefined;
    reason?: undefined;
} | {
    approved: true;
    reason: string;
    status?: undefined;
    code?: undefined;
}>;
/** The receipt shape core's `send` returns, reduced to what this flow reads. */
export type SendReceipt = {
    status: "accepted" | "duplicate";
    threadId: string;
} | {
    status: "rejected";
    code: string;
};
/** Model-facing consent statement placed at the start of the fresh request. */
export declare const CONSENT_TEXT = "The user approved continuing beyond the budget.";
export type ResumeAfterBudgetStop<Receipt extends SendReceipt> = {
    threadId: string;
    /** The `continue_budget` approval the user answered on this thread. */
    approvalId: string;
    /** Optional extra instruction appended to the consent statement. */
    instruction?: string;
    /** Spend the host's recorded consent (see `continueBudgetState.consume`): true
     * exactly once, only for this owner, thread, approval and stopped run. The helper
     * never calls `respond`, so a pending approval can never be approved on the
     * user's behalf. Must fail closed: anything else is `false`. */
    consumeConsent: (args: {
        threadId: string;
        approvalId: string;
        runId: string;
    }) => Promise<boolean>;
    /** Core `activity`; its `runId` is the id your budget slot received. */
    activity: () => Promise<{
        errorCode: string | null;
        runId?: string | null;
    }>;
    /** Host budget policy write. Runs in the same transaction as cancel and send. */
    raiseBudget: () => Promise<unknown>;
    /** Core `cancel` for the stopped thread. */
    cancel: () => Promise<unknown>;
    /** Core `send` with the supplied `text` and `requestKey`. */
    send: (args: {
        text: string;
        requestKey: string;
    }) => Promise<Receipt>;
};
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
export declare function resumeAfterBudgetStop<Receipt extends SendReceipt>(flow: ResumeAfterBudgetStop<Receipt>): Promise<{
    status: "no-consent";
} | {
    status: "not-stopped";
} | {
    status: "resumed";
    receipt: Exclude<Receipt, {
        status: "rejected" | "duplicate";
    }>;
}>;
