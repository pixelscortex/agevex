import type { FunctionReference } from "convex/server";
import { z } from "zod";
export declare const GOAL_LIMITS: {
    readonly minChars: 1;
    readonly goalChars: 4000;
    readonly cleanupBatch: 128;
};
export declare const goalText: z.ZodString;
type Scope = {
    subject: string;
    threadId: string;
};
export type GoalFunctions = {
    check: FunctionReference<"query", "internal", Scope, {
        goal: string | null;
    }>;
    set: FunctionReference<"mutation", "internal", Scope & {
        goal: string;
    }, {
        goal: string;
    }>;
};
/** Register goal tools on an Agent; fenced ToolContext facts scope one goal per owner/thread across runs. */
export declare function createGoalTools(refs: GoalFunctions): {
    goal_set: import("ai").Tool<{
        goal: string;
    }, {
        goal: string;
    }>;
    goal_check: import("ai").Tool<Record<string, never>, {
        goal: string | null;
    }>;
};
export {};
