/** Native thread text policy. Temporary capabilities use the existing receipts
 * ledger; title bodies are never stored by agevex. */
import { v } from "convex/values";

import { valueBytes } from "../../shared/json.js";

export const TEXT_LIMITS = {
  titleCharacters: 120,
  titleBytes: 512,
  inputBytes: 48 << 10,
  promptCharacters: 4 << 10,
  taskPromptCharacters: 64 << 10,
  timeoutMs: 30_000,
  leaseMs: 35_000,
  titleTokens: 128,
} as const;

export const textArgs = { assignmentId: v.string() };
export const textConfig = v.object({
  worker: v.string(),
  updateThread: v.string(),
  getThread: v.string(),
});

/** Count encoded output as well as characters before updating native metadata. */
export function validText(text: string) {
  return (
    !!text.trim() &&
    valueBytes(text) <= TEXT_LIMITS.titleBytes &&
    Array.from(text).length <= TEXT_LIMITS.titleCharacters
  );
}
