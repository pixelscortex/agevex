/** Native thread text policy. Temporary capabilities use the existing receipts
 * ledger; title and summary bodies are never stored by agevex. */
import { v, getConvexSize } from "convex/values";

export const TEXT_LIMITS = {
  titleCharacters: 120,
  titleBytes: 512,
  summaryBytes: 8 << 10,
  inputBytes: 48 << 10,
  readBytes: 2 << 20,
  messages: 24,
  promptCharacters: 4 << 10,
  taskPromptCharacters: 64 << 10,
  timeoutMs: 30_000,
  leaseMs: 35_000,
  titleTokens: 128,
  summaryTokens: 2048,
} as const;

export const textKind = v.union(v.literal("title"), v.literal("summary"));
export const textArgs = { assignmentId: v.string(), kind: textKind, key: v.string() };
export const textConfig = v.object({
  worker: v.string(),
  updateThread: v.string(),
  getThread: v.string(),
  title: v.boolean(),
  summary: v.boolean(),
});

/** Count encoded output as well as characters before updating native metadata. */
export function validText(text: string, kind: "title" | "summary") {
  return (
    !!text.trim() &&
    Math.max(new TextEncoder().encode(JSON.stringify(text)).length, getConvexSize(text)) <=
      (kind === "title" ? TEXT_LIMITS.titleBytes : TEXT_LIMITS.summaryBytes) &&
    (kind !== "title" || Array.from(text).length <= TEXT_LIMITS.titleCharacters)
  );
}
