import { defineOnceTool } from "agevex";
import { z } from "zod";

export const CONTINUE_BUDGET_LIMITS = { minChars: 1, reasonChars: 2000 } as const;
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
 * This only requests consent. It neither changes a budget nor bypasses core's
 * run limits. The native approval (answered through core `respond`) is the
 * consent record; denial never executes the tool. The host applies its own
 * budget policy afterwards (see `resumeAfterBudgetStop`).
 */
export function createContinueBudgetTool() {
  const approval = defineOnceTool({
    name: "continue_budget",
    input: continueInput,
    run: (input, tc) => {
      tc.signal.throwIfAborted();
      return { approved: true, reason: input.reason };
    },
  });
  approval.description =
    "Ask the user for explicit permission to spend more before the budget runs out. Approval is consent only; the host changes its budget policy separately.";
  approval.needsApproval = true;
  return approval;
}

/** The receipt shape core's `send` returns, reduced to what this flow reads. */
export type SendReceipt =
  | { status: "accepted" | "duplicate"; threadId: string }
  | { status: "rejected"; code: string };

export type ResumeAfterBudgetStop<Receipt extends SendReceipt> = {
  /** Explicit spending consent from the user (e.g. an approved `continue_budget`). */
  consent: boolean;
  /** Core `activity` for the stopped thread. */
  activity: () => Promise<{ errorCode: string | null }>;
  /** Host budget policy update. Must be idempotent (set an absolute limit). */
  raiseBudget: () => Promise<unknown>;
  /** Core `cancel` for the stopped thread. */
  cancel: () => Promise<unknown>;
  /** Core `send` with a stable `requestKey`, so a retried flow cannot duplicate the request. */
  send: () => Promise<Receipt>;
};

/**
 * Host-side half: continue a run that core stopped with `BUDGET_EXCEEDED`.
 *
 * Core never resumes a stopped run, because the step that tripped the budget may
 * have been paid for with an unknown outcome. The only supported path is:
 *   1. explicit spending consent,
 *   2. the host updates its budget policy,
 *   3. cancel the stopped run (clears its recovery state and discards its notes),
 *   4. send a fresh request (a new run with its own run id).
 *
 * The order matters: raising the budget first means a failure leaves the run
 * stopped and nothing cancelled; cancelling before the raise could leave a
 * cancelled thread whose next request is denied again. Retrying: if `raiseBudget`
 * or `cancel` fails, call this again (the thread still reports BUDGET_EXCEEDED;
 * `raiseBudget` must be idempotent). Once `cancel` succeeded the stop is cleared,
 * so a failed `send` is retried by calling core `send` directly with the same
 * `requestKey` (a repeat returns `duplicate`). Nothing runs without consent, and
 * a thread that is not stopped for budget is left untouched (no cancel of
 * healthy work).
 */
export async function resumeAfterBudgetStop<Receipt extends SendReceipt>(
  flow: ResumeAfterBudgetStop<Receipt>,
): Promise<
  | { status: "no-consent" }
  | { status: "not-stopped" }
  | { status: "resumed"; receipt: Exclude<Receipt, { status: "rejected" }> }
> {
  if (flow.consent !== true) return { status: "no-consent" };
  if ((await flow.activity()).errorCode !== "BUDGET_EXCEEDED") return { status: "not-stopped" };
  await flow.raiseBudget();
  await flow.cancel();
  const receipt = await flow.send();
  if (receipt.status === "rejected") throw new Error(receipt.code);
  return { status: "resumed", receipt: receipt as Exclude<Receipt, { status: "rejected" }> };
}
