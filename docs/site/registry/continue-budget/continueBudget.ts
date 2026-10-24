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
 * This requests consent only. It neither changes a meter budget nor bypasses
 * the core run limit; the host must apply any budget change under its policy.
 * Agent 0.7.7's native approval (approvals.ts:65-82) owns the decision, and
 * core respond owns the wake-up. No separate budget/approval table is needed.
 */
export function createContinueBudgetTool() {
  const approval = defineOnceTool({
    name: "continue_budget",
    input: continueInput,
    run: (input, tc) => {
      tc.signal.throwIfAborted();
      return { approved: true, reason: continueInput.parse(input).reason };
    },
  });
  approval.description =
    "Request permission to continue before reaching a hard budget limit. Approval is consent only; the host must change its budget policy separately.";
  approval.needsApproval = true;
  return approval;
}
