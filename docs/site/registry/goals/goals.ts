import { defineOnceTool } from "agevex";
import type { FunctionReference } from "convex/server";
import { z } from "zod";

export const GOAL_LIMITS = { minChars: 1, goalChars: 4000, cleanupBatch: 128 } as const;
export const goalText = z.string().trim().min(GOAL_LIMITS.minChars).max(GOAL_LIMITS.goalChars);
// Core validates every ToolContext fact (nonempty, at most LIMITS.factBytes
// UTF-8 bytes) before a tool runs, so the scope is passed through unchanged.
type Scope = { subject: string; threadId: string; runId: string };
export type GoalFunctions = {
  check: FunctionReference<"query", "internal", Scope, { goal: string | null }>;
  set: FunctionReference<"mutation", "internal", Scope & { goal: string }, { goal: string }>;
};

/** One explicit goal per owner and thread, owned by the run that set it. */
export function createGoalTools(refs: GoalFunctions) {
  const tools = {
    goal_set: defineOnceTool({
      name: "goal_set",
      input: z.strictObject({ goal: goalText }),
      run: async (input, tc) => {
        tc.signal.throwIfAborted();
        // `input` was validated by AI SDK; ownership comes from ToolContext only.
        return tc.ctx.runMutation(refs.set, {
          subject: tc.subject,
          threadId: tc.threadId,
          runId: tc.runId,
          goal: input.goal,
        });
      },
    }),
    goal_check: defineOnceTool({
      name: "goal_check",
      input: z.strictObject({}),
      run: async (_input, tc) => {
        tc.signal.throwIfAborted();
        return tc.ctx.runQuery(refs.check, {
          subject: tc.subject,
          threadId: tc.threadId,
          runId: tc.runId,
        });
      },
    }),
  };
  tools.goal_set.description =
    "Set the explicit goal for this owner's thread and current user run, replacing any earlier run's goal. Report progress against this goal.";
  tools.goal_check.description =
    "Read this run's goal, or null when unset. Assess your work against it; this tool does not independently verify success.";
  return tools;
}
