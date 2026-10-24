import { defineOnceTool } from "agevex";
import type { FunctionReference } from "convex/server";
import { z } from "zod";

export const GOAL_LIMITS = { minChars: 1, goalChars: 4000, scopeChars: 1024 } as const;
export const goalText = z.string().trim().min(GOAL_LIMITS.minChars).max(GOAL_LIMITS.goalChars);
export const goalScope = z.strictObject({
  subject: z.string().min(GOAL_LIMITS.minChars).max(GOAL_LIMITS.scopeChars),
  threadId: z.string().min(GOAL_LIMITS.minChars).max(GOAL_LIMITS.scopeChars),
  runId: z.string().min(GOAL_LIMITS.minChars).max(GOAL_LIMITS.scopeChars),
});
type Scope = z.infer<typeof goalScope>;
export type GoalFunctions = {
  check: FunctionReference<"query", "internal", Scope, { goal: string | null }>;
  set: FunctionReference<"mutation", "internal", Scope & { goal: string }, { goal: string }>;
};

/** One explicit goal per owner, thread and user run; checking reads it back. */
export function createGoalTools(refs: GoalFunctions) {
  const tools = {
    goal_set: defineOnceTool({
      name: "goal_set",
      input: z.strictObject({ goal: goalText }),
      run: async (input, tc) => {
        tc.signal.throwIfAborted();
        const { goal } = z.strictObject({ goal: goalText }).parse(input);
        const scope = goalScope.parse({
          subject: tc.subject,
          threadId: tc.threadId,
          runId: tc.runId,
        });
        return tc.ctx.runMutation(refs.set, { ...scope, goal });
      },
    }),
    goal_check: defineOnceTool({
      name: "goal_check",
      input: z.strictObject({}),
      run: async (_input, tc) => {
        tc.signal.throwIfAborted();
        const scope = goalScope.parse({
          subject: tc.subject,
          threadId: tc.threadId,
          runId: tc.runId,
        });
        return tc.ctx.runQuery(refs.check, scope);
      },
    }),
  };
  tools.goal_set.description =
    "Set the explicit goal for this owner's current thread and user run. Report progress against this goal.";
  tools.goal_check.description =
    "Read this run's goal, or null when unset. Assess your work against it; this tool does not independently verify success.";
  return tools;
}
