/** Public request-tree validators; optional modules supply usage through a slot. */
import { v, type Infer } from "convex/values";
import { HOST_LIMITS } from "./limits.js";

export const TREE_LIMITS = {
  descendants: HOST_LIMITS.runLaunches.max,
  toolNameBytes: 128,
  childBytes: 4 << 10,
  childGrowthBytes: 1 << 10,
  outputBytes: 128 << 10,
} as const;

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
  status: v.union(
    v.literal("queued"),
    v.literal("running"),
    v.literal("asleep"),
    v.literal("done"),
    v.literal("failed"),
  ),
  reason: v.optional(
    v.union(
      v.literal("children"),
      v.literal("approval"),
      v.literal("ask"),
      v.literal("budget"),
      v.literal("cancelled"),
      v.literal("recovery"),
    ),
  ),
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
export const runTree = v.union(
  v.null(),
  v.object({
    rootRunId: v.string(),
    usage: v.union(usageView, v.null()),
    nodes: v.array(runNode),
  }),
);
export type RunNode = Infer<typeof runNode>;
export type RunTree = Infer<typeof runTree>;
