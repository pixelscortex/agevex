/** Public request-tree validators; optional modules supply usage through a slot. */
import { v } from "convex/values";
import { HOST_LIMITS } from "./limits.js";
export const TREE_LIMITS = {
    descendants: HOST_LIMITS.runLaunches.max + HOST_LIMITS.sideRunsPerRun.max,
    taskBytes: 256,
    toolNameBytes: 128,
    childBytes: 4 << 10,
    childGrowthBytes: 1 << 10,
    outputBytes: 128 << 10,
};
export const usageView = v.object({
    inputTokens: v.union(v.number(), v.null()),
    outputTokens: v.union(v.number(), v.null()),
    estimatedUsd: v.number(),
    settledUsd: v.number(),
    unknown: v.number(),
    reporting: v.union(v.literal("available"), v.literal("partial")),
});
export const runNode = v.object({
    id: v.string(),
    parentId: v.union(v.string(), v.null()),
    agent: v.string(),
    task: v.string(),
    status: v.union(v.literal("queued"), v.literal("running"), v.literal("asleep"), v.literal("done"), v.literal("failed")),
    reason: v.optional(v.union(v.literal("children"), v.literal("approval"), v.literal("ask"), v.literal("budget"), v.literal("cancelled"), v.literal("recovery"))),
    error: v.optional(v.string()),
    createdAt: v.number(),
    startedAt: v.union(v.number(), v.null()),
    finishedAt: v.union(v.number(), v.null()),
    currentTool: v.union(v.string(), v.null()),
    usage: v.union(usageView, v.null()),
    messages: v.object({
        threadId: v.string(),
        taskId: v.optional(v.string()),
        resultId: v.optional(v.string()),
        parentResultId: v.optional(v.string()),
        questionId: v.optional(v.string()),
    }),
});
export const runTree = v.union(v.null(), v.object({
    rootRunId: v.string(),
    usage: v.union(usageView, v.null()),
    nodes: v.array(runNode),
}));
/** Stream decoding omits an incomplete final code point, keeping the UTF-8 cap. */
export function taskPreview(text) {
    let preview = new TextDecoder().decode(new TextEncoder().encode(text).slice(0, TREE_LIMITS.taskBytes), {
        stream: true,
    });
    // Escaped control characters also consume output bytes. A preview may be
    // shorter than 256 raw bytes so JSON and Convex envelopes remain bounded.
    while (new TextEncoder().encode(JSON.stringify(preview)).length > TREE_LIMITS.taskBytes)
        preview = Array.from(preview).slice(0, -1).join("");
    return preview;
}
