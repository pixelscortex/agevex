/** Public request-tree validators; optional modules supply usage through a slot. */
import { type Infer } from "convex/values";
export declare const TREE_LIMITS: {
    readonly descendants: number;
    readonly taskBytes: 256;
    readonly toolNameBytes: 128;
    readonly childBytes: number;
    readonly childGrowthBytes: number;
    readonly outputBytes: number;
};
export declare const usageView: import("convex/values").VObject<{
    unknown: number;
    inputTokens: number | null;
    outputTokens: number | null;
    estimatedUsd: number;
    settledUsd: number;
    reporting: "partial" | "available";
}, {
    inputTokens: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
    outputTokens: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
    estimatedUsd: import("convex/values").VFloat64<number, "required">;
    settledUsd: import("convex/values").VFloat64<number, "required">;
    unknown: import("convex/values").VFloat64<number, "required">;
    reporting: import("convex/values").VUnion<"partial" | "available", [import("convex/values").VLiteral<"available", "required">, import("convex/values").VLiteral<"partial", "required">], "required", never>;
}, "required", "unknown" | "inputTokens" | "outputTokens" | "estimatedUsd" | "settledUsd" | "reporting">;
export declare const runNode: import("convex/values").VObject<{
    error?: string | undefined;
    reason?: "cancelled" | "ask" | "children" | "approval" | "budget" | "recovery" | undefined;
    id: string;
    startedAt: number | null;
    status: "failed" | "running" | "queued" | "done" | "asleep";
    agent: string;
    finishedAt: number | null;
    createdAt: number;
    messages: {
        taskId?: string | undefined;
        resultId?: string | undefined;
        parentResultId?: string | undefined;
        questionId?: string | undefined;
        threadId: string;
    };
    usage: {
        unknown: number;
        inputTokens: number | null;
        outputTokens: number | null;
        estimatedUsd: number;
        settledUsd: number;
        reporting: "partial" | "available";
    } | null;
    parentId: string | null;
    task: string;
    currentTool: string | null;
}, {
    id: import("convex/values").VString<string, "required">;
    parentId: import("convex/values").VUnion<string | null, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "required", never>;
    agent: import("convex/values").VString<string, "required">;
    task: import("convex/values").VString<string, "required">;
    status: import("convex/values").VUnion<"failed" | "running" | "queued" | "done" | "asleep", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"asleep", "required">, import("convex/values").VLiteral<"done", "required">, import("convex/values").VLiteral<"failed", "required">], "required", never>;
    reason: import("convex/values").VUnion<"cancelled" | "ask" | "children" | "approval" | "budget" | "recovery" | undefined, [import("convex/values").VLiteral<"children", "required">, import("convex/values").VLiteral<"approval", "required">, import("convex/values").VLiteral<"ask", "required">, import("convex/values").VLiteral<"budget", "required">, import("convex/values").VLiteral<"cancelled", "required">, import("convex/values").VLiteral<"recovery", "required">], "optional", never>;
    error: import("convex/values").VString<string | undefined, "optional">;
    createdAt: import("convex/values").VFloat64<number, "required">;
    startedAt: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
    finishedAt: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
    currentTool: import("convex/values").VUnion<string | null, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "required", never>;
    usage: import("convex/values").VUnion<{
        unknown: number;
        inputTokens: number | null;
        outputTokens: number | null;
        estimatedUsd: number;
        settledUsd: number;
        reporting: "partial" | "available";
    } | null, [import("convex/values").VObject<{
        unknown: number;
        inputTokens: number | null;
        outputTokens: number | null;
        estimatedUsd: number;
        settledUsd: number;
        reporting: "partial" | "available";
    }, {
        inputTokens: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
        outputTokens: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
        estimatedUsd: import("convex/values").VFloat64<number, "required">;
        settledUsd: import("convex/values").VFloat64<number, "required">;
        unknown: import("convex/values").VFloat64<number, "required">;
        reporting: import("convex/values").VUnion<"partial" | "available", [import("convex/values").VLiteral<"available", "required">, import("convex/values").VLiteral<"partial", "required">], "required", never>;
    }, "required", "unknown" | "inputTokens" | "outputTokens" | "estimatedUsd" | "settledUsd" | "reporting">, import("convex/values").VNull<null, "required">], "required", "unknown" | "inputTokens" | "outputTokens" | "estimatedUsd" | "settledUsd" | "reporting">;
    messages: import("convex/values").VObject<{
        taskId?: string | undefined;
        resultId?: string | undefined;
        parentResultId?: string | undefined;
        questionId?: string | undefined;
        threadId: string;
    }, {
        threadId: import("convex/values").VString<string, "required">;
        taskId: import("convex/values").VString<string | undefined, "optional">;
        resultId: import("convex/values").VString<string | undefined, "optional">;
        parentResultId: import("convex/values").VString<string | undefined, "optional">;
        questionId: import("convex/values").VString<string | undefined, "optional">;
    }, "required", "threadId" | "taskId" | "resultId" | "parentResultId" | "questionId">;
}, "required", "id" | "error" | "startedAt" | "status" | "agent" | "finishedAt" | "createdAt" | "reason" | "messages" | "usage" | "parentId" | "task" | "currentTool" | "messages.threadId" | "messages.taskId" | "messages.resultId" | "messages.parentResultId" | "messages.questionId" | "usage.unknown" | "usage.inputTokens" | "usage.outputTokens" | "usage.estimatedUsd" | "usage.settledUsd" | "usage.reporting">;
export declare const runTree: import("convex/values").VUnion<{
    usage: {
        unknown: number;
        inputTokens: number | null;
        outputTokens: number | null;
        estimatedUsd: number;
        settledUsd: number;
        reporting: "partial" | "available";
    } | null;
    rootRunId: string;
    nodes: {
        error?: string | undefined;
        reason?: "cancelled" | "ask" | "children" | "approval" | "budget" | "recovery" | undefined;
        id: string;
        startedAt: number | null;
        status: "failed" | "running" | "queued" | "done" | "asleep";
        agent: string;
        finishedAt: number | null;
        createdAt: number;
        messages: {
            taskId?: string | undefined;
            resultId?: string | undefined;
            parentResultId?: string | undefined;
            questionId?: string | undefined;
            threadId: string;
        };
        usage: {
            unknown: number;
            inputTokens: number | null;
            outputTokens: number | null;
            estimatedUsd: number;
            settledUsd: number;
            reporting: "partial" | "available";
        } | null;
        parentId: string | null;
        task: string;
        currentTool: string | null;
    }[];
} | null, [import("convex/values").VNull<null, "required">, import("convex/values").VObject<{
    usage: {
        unknown: number;
        inputTokens: number | null;
        outputTokens: number | null;
        estimatedUsd: number;
        settledUsd: number;
        reporting: "partial" | "available";
    } | null;
    rootRunId: string;
    nodes: {
        error?: string | undefined;
        reason?: "cancelled" | "ask" | "children" | "approval" | "budget" | "recovery" | undefined;
        id: string;
        startedAt: number | null;
        status: "failed" | "running" | "queued" | "done" | "asleep";
        agent: string;
        finishedAt: number | null;
        createdAt: number;
        messages: {
            taskId?: string | undefined;
            resultId?: string | undefined;
            parentResultId?: string | undefined;
            questionId?: string | undefined;
            threadId: string;
        };
        usage: {
            unknown: number;
            inputTokens: number | null;
            outputTokens: number | null;
            estimatedUsd: number;
            settledUsd: number;
            reporting: "partial" | "available";
        } | null;
        parentId: string | null;
        task: string;
        currentTool: string | null;
    }[];
}, {
    rootRunId: import("convex/values").VString<string, "required">;
    usage: import("convex/values").VUnion<{
        unknown: number;
        inputTokens: number | null;
        outputTokens: number | null;
        estimatedUsd: number;
        settledUsd: number;
        reporting: "partial" | "available";
    } | null, [import("convex/values").VObject<{
        unknown: number;
        inputTokens: number | null;
        outputTokens: number | null;
        estimatedUsd: number;
        settledUsd: number;
        reporting: "partial" | "available";
    }, {
        inputTokens: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
        outputTokens: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
        estimatedUsd: import("convex/values").VFloat64<number, "required">;
        settledUsd: import("convex/values").VFloat64<number, "required">;
        unknown: import("convex/values").VFloat64<number, "required">;
        reporting: import("convex/values").VUnion<"partial" | "available", [import("convex/values").VLiteral<"available", "required">, import("convex/values").VLiteral<"partial", "required">], "required", never>;
    }, "required", "unknown" | "inputTokens" | "outputTokens" | "estimatedUsd" | "settledUsd" | "reporting">, import("convex/values").VNull<null, "required">], "required", "unknown" | "inputTokens" | "outputTokens" | "estimatedUsd" | "settledUsd" | "reporting">;
    nodes: import("convex/values").VArray<{
        error?: string | undefined;
        reason?: "cancelled" | "ask" | "children" | "approval" | "budget" | "recovery" | undefined;
        id: string;
        startedAt: number | null;
        status: "failed" | "running" | "queued" | "done" | "asleep";
        agent: string;
        finishedAt: number | null;
        createdAt: number;
        messages: {
            taskId?: string | undefined;
            resultId?: string | undefined;
            parentResultId?: string | undefined;
            questionId?: string | undefined;
            threadId: string;
        };
        usage: {
            unknown: number;
            inputTokens: number | null;
            outputTokens: number | null;
            estimatedUsd: number;
            settledUsd: number;
            reporting: "partial" | "available";
        } | null;
        parentId: string | null;
        task: string;
        currentTool: string | null;
    }[], import("convex/values").VObject<{
        error?: string | undefined;
        reason?: "cancelled" | "ask" | "children" | "approval" | "budget" | "recovery" | undefined;
        id: string;
        startedAt: number | null;
        status: "failed" | "running" | "queued" | "done" | "asleep";
        agent: string;
        finishedAt: number | null;
        createdAt: number;
        messages: {
            taskId?: string | undefined;
            resultId?: string | undefined;
            parentResultId?: string | undefined;
            questionId?: string | undefined;
            threadId: string;
        };
        usage: {
            unknown: number;
            inputTokens: number | null;
            outputTokens: number | null;
            estimatedUsd: number;
            settledUsd: number;
            reporting: "partial" | "available";
        } | null;
        parentId: string | null;
        task: string;
        currentTool: string | null;
    }, {
        id: import("convex/values").VString<string, "required">;
        parentId: import("convex/values").VUnion<string | null, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "required", never>;
        agent: import("convex/values").VString<string, "required">;
        task: import("convex/values").VString<string, "required">;
        status: import("convex/values").VUnion<"failed" | "running" | "queued" | "done" | "asleep", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"asleep", "required">, import("convex/values").VLiteral<"done", "required">, import("convex/values").VLiteral<"failed", "required">], "required", never>;
        reason: import("convex/values").VUnion<"cancelled" | "ask" | "children" | "approval" | "budget" | "recovery" | undefined, [import("convex/values").VLiteral<"children", "required">, import("convex/values").VLiteral<"approval", "required">, import("convex/values").VLiteral<"ask", "required">, import("convex/values").VLiteral<"budget", "required">, import("convex/values").VLiteral<"cancelled", "required">, import("convex/values").VLiteral<"recovery", "required">], "optional", never>;
        error: import("convex/values").VString<string | undefined, "optional">;
        createdAt: import("convex/values").VFloat64<number, "required">;
        startedAt: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
        finishedAt: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
        currentTool: import("convex/values").VUnion<string | null, [import("convex/values").VString<string, "required">, import("convex/values").VNull<null, "required">], "required", never>;
        usage: import("convex/values").VUnion<{
            unknown: number;
            inputTokens: number | null;
            outputTokens: number | null;
            estimatedUsd: number;
            settledUsd: number;
            reporting: "partial" | "available";
        } | null, [import("convex/values").VObject<{
            unknown: number;
            inputTokens: number | null;
            outputTokens: number | null;
            estimatedUsd: number;
            settledUsd: number;
            reporting: "partial" | "available";
        }, {
            inputTokens: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
            outputTokens: import("convex/values").VUnion<number | null, [import("convex/values").VFloat64<number, "required">, import("convex/values").VNull<null, "required">], "required", never>;
            estimatedUsd: import("convex/values").VFloat64<number, "required">;
            settledUsd: import("convex/values").VFloat64<number, "required">;
            unknown: import("convex/values").VFloat64<number, "required">;
            reporting: import("convex/values").VUnion<"partial" | "available", [import("convex/values").VLiteral<"available", "required">, import("convex/values").VLiteral<"partial", "required">], "required", never>;
        }, "required", "unknown" | "inputTokens" | "outputTokens" | "estimatedUsd" | "settledUsd" | "reporting">, import("convex/values").VNull<null, "required">], "required", "unknown" | "inputTokens" | "outputTokens" | "estimatedUsd" | "settledUsd" | "reporting">;
        messages: import("convex/values").VObject<{
            taskId?: string | undefined;
            resultId?: string | undefined;
            parentResultId?: string | undefined;
            questionId?: string | undefined;
            threadId: string;
        }, {
            threadId: import("convex/values").VString<string, "required">;
            taskId: import("convex/values").VString<string | undefined, "optional">;
            resultId: import("convex/values").VString<string | undefined, "optional">;
            parentResultId: import("convex/values").VString<string | undefined, "optional">;
            questionId: import("convex/values").VString<string | undefined, "optional">;
        }, "required", "threadId" | "taskId" | "resultId" | "parentResultId" | "questionId">;
    }, "required", "id" | "error" | "startedAt" | "status" | "agent" | "finishedAt" | "createdAt" | "reason" | "messages" | "usage" | "parentId" | "task" | "currentTool" | "messages.threadId" | "messages.taskId" | "messages.resultId" | "messages.parentResultId" | "messages.questionId" | "usage.unknown" | "usage.inputTokens" | "usage.outputTokens" | "usage.estimatedUsd" | "usage.settledUsd" | "usage.reporting">, "required">;
}, "required", "usage" | "rootRunId" | "nodes" | "usage.unknown" | "usage.inputTokens" | "usage.outputTokens" | "usage.estimatedUsd" | "usage.settledUsd" | "usage.reporting">], "required", "usage" | "rootRunId" | "nodes" | "usage.unknown" | "usage.inputTokens" | "usage.outputTokens" | "usage.estimatedUsd" | "usage.settledUsd" | "usage.reporting">;
export type RunNode = Infer<typeof runNode>;
export type RunTree = Infer<typeof runTree>;
/** Stream decoding omits an incomplete final code point, keeping the UTF-8 cap. */
export declare function taskPreview(text: string): string;
