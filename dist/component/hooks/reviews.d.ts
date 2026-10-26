/** The message refs a side reviewer should read now, or null if not due. */
export declare const reviewContext: import("convex/server").RegisteredQuery<"public", {
    turns?: number | undefined;
    minutes?: number | undefined;
    agent: string;
    executionId: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<{
    refs: {
        order: number;
        bytes: number;
        id: string;
        stepOrder: number;
        sequence: number;
    }[];
    boundary: number;
} | null>>;
/** Record a side reviewer's consumed boundary. */
export declare const reviewed: import("convex/server").RegisteredMutation<"public", {
    agent: string;
    boundary: number;
    executionId: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<null>>;
/** Host coordinator saves (results, questions and follow-ups) do not pass
 * through the action's native-save fence. Capture their identities inside that
 * same host mutation too, so delta never omits a non-model message. */
export declare const capture: import("convex/server").RegisteredMutation<"public", {
    threadId: string;
    savedMessage: {
        order: number;
        bytes: number;
        id: string;
        stepOrder: number;
    };
}, Promise<null>>;
