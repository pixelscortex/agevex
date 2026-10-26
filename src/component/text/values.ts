/** Bounded background-text state. Bodies stay native except the small summary;
 * task capabilities, epochs and versions fence every scheduled metadata write. */
import { v, getConvexSize } from "convex/values";

export const TEXT_LIMITS = {
  titleCharacters: 120,
  titleBytes: 512,
  summaryBytes: 8 << 10,
  inputBytes: 48 << 10,
  readBytes: 2 << 20,
  promptCharacters: 4 << 10,
  taskPromptCharacters: 64 << 10,
  timeoutMs: 30_000,
  leaseMs: 35_000,
  titleTokens: 128,
  summaryTokens: 2048,
  everyTurns: 1_000_000,
} as const;

export const textKind = v.union(v.literal("title"), v.literal("summary"));
export const textArgs = { assignmentId: v.string(), kind: textKind, key: v.string() };
export const textConfig = v.object({
  worker: v.string(),
  updateThread: v.string(),
  title: v.boolean(),
  summary: v.boolean(),
  everyTurns: v.optional(v.number()),
});
export const textBoundary = v.object({
  id: v.string(),
  order: v.number(),
  stepOrder: v.number(),
  sequence: v.number(),
});
export const textJob = v.object({
  key: v.string(),
  runId: v.id("runs"),
  epoch: v.number(),
  version: v.number(),
  status: v.union(
    v.literal("queued"),
    v.literal("running"),
    v.literal("done"),
    v.literal("failed"),
    v.literal("unknown"),
  ),
  again: v.optional(v.id("runs")),
  deferred: v.optional(v.boolean()),
  titleRef: v.optional(
    v.object({ id: v.string(), order: v.number(), stepOrder: v.number(), bytes: v.number() }),
  ),
});
export const storedSummary = v.object({
  text: v.string(),
  through: textBoundary,
  complete: v.boolean(),
  epoch: v.number(),
});

/** Count encoded output as well as characters before either metadata store. */
export function validText(text: string, kind: "title" | "summary") {
  return (
    !!text.trim() &&
    Math.max(new TextEncoder().encode(JSON.stringify(text)).length, getConvexSize(text)) <=
      (kind === "title" ? TEXT_LIMITS.titleBytes : TEXT_LIMITS.summaryBytes) &&
    (kind !== "title" || Array.from(text).length <= TEXT_LIMITS.titleCharacters)
  );
}
