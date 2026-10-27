/** Native thread text policy. Temporary capabilities use the existing receipts
 * ledger; title bodies are never stored by agevex. */
import { v, getConvexSize } from "convex/values";
export const TEXT_LIMITS = {
    titleCharacters: 120,
    titleBytes: 512,
    inputBytes: 48 << 10,
    promptCharacters: 4 << 10,
    taskPromptCharacters: 64 << 10,
    timeoutMs: 30_000,
    leaseMs: 35_000,
    titleTokens: 128,
};
export const textKind = v.literal("title");
export const textArgs = { assignmentId: v.string(), kind: textKind, key: v.string() };
export const textConfig = v.object({
    worker: v.string(),
    updateThread: v.string(),
    getThread: v.string(),
});
/** Count encoded output as well as characters before updating native metadata. */
export function validText(text, _kind) {
    return (!!text.trim() &&
        Math.max(new TextEncoder().encode(JSON.stringify(text)).length, getConvexSize(text)) <=
            TEXT_LIMITS.titleBytes &&
        Array.from(text).length <= TEXT_LIMITS.titleCharacters);
}
