/** Public tool-free background text policy and registration-time hard bounds. */
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import type { Registration, ManagedAgent } from "../types.js";
export type TextTaskOptions = {
    model?: Extract<LanguageModel, string | LanguageModelV4>;
    prompt?: string;
    /** Output cap for this call. Defaults to 128 for titles and 2048 for summaries;
     * must be a positive integer within the task bound (`LIMITS.outputTokens`, 4096). */
    maxOutputTokens?: number;
};
export type ThreadTextOptions = {
    /** On by default, once after the first user message. User renames always win. */
    title?: false | TextTaskOptions;
    /** Opt in for on-demand summaries; cadence is a separate opt-in. */
    summary?: false | (TextTaskOptions & {
        everyTurns?: number;
    });
};
export type TextTaskArgs = {
    assignmentId: string;
    kind: "title" | "summary";
    key: string;
};
/** Fail before request acceptance when the host cannot dispatch metadata work. */
export declare function assertTextOptions(config: Registration): void;
/** Native update handle crosses the component boundary so automatic title and
 * version/source commit in one mutation (Agent client/threads.ts:55-64). */
export declare function persistedTextConfig(config: Registration, native: ManagedAgent): Promise<{
    worker: import("convex/server").FunctionHandle<"action", TextTaskArgs, null>;
    updateThread: import("convex/server").FunctionHandle<"mutation", {
        patch: {
            status?: "active" | "archived";
            summary?: string;
            title?: string;
            userId?: string;
        };
        threadId: string;
    }, {
        _creationTime: number;
        _id: string;
        status: "active" | "archived";
        summary?: string;
        title?: string;
        userId?: string;
    }>;
    getThread: import("convex/server").FunctionHandle<"query", {
        threadId: string;
    }, {
        _creationTime: number;
        _id: string;
        status: "active" | "archived";
        summary?: string;
        title?: string;
        userId?: string;
    } | null>;
    title: boolean;
    summary: boolean;
    everyTurns: number | undefined;
} | undefined>;
