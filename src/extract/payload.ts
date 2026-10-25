import { z } from "zod";
import { LIMITS, bounded, integer, utf8 } from "./limits.js";
import { ExtractError } from "./backends.js";
import type { ExtractedDoc, ProviderUsage } from "./types.js";

const docSchema = z.object({
  kind: z.enum(["text", "document", "image"]),
  text: z.string(),
  pages: z
    .array(
      z.object({ number: z.number().int().positive().max(LIMITS.totalPages), text: z.string() }),
    )
    .max(LIMITS.totalPages)
    .optional(),
  language: z.string().optional(),
});
/** Strip unknown fields: provider bodies must never be copied into durable JSON. */
export function parseDocument(value: unknown): ExtractedDoc {
  const parsed = docSchema.safeParse(value);
  if (!parsed.success) throw new ExtractError("INVALID_OUTPUT");
  const doc = parsed.data;
  if (doc.language) bounded(doc.language);
  if (!doc.text.trim()) throw new ExtractError("EMPTY");
  if (doc.pages?.some((page, index) => page.number !== index + 1))
    throw new ExtractError("INVALID_OUTPUT");
  return doc;
}
/**
 * Reads trust what `document` validated and stored: re-running the schema would
 * copy every page object again (and `trim` the whole text) on each window. Check
 * only the shape the readers touch, without allocating.
 */
export function readDocument(value: unknown): ExtractedDoc {
  const doc = value as Partial<ExtractedDoc> | null;
  if (
    !doc ||
    typeof doc.text !== "string" ||
    (doc.pages !== undefined &&
      (!Array.isArray(doc.pages) ||
        doc.pages.some((page) => typeof page?.text !== "string" || !Number.isInteger(page.number))))
  )
    throw new ExtractError("INVALID_OUTPUT");
  return doc as ExtractedDoc;
}
/** Serialize only on writes; a read must not allocate another full 32 MiB JSON blob. */
export function document(value: unknown, maxBytes: number): { doc: ExtractedDoc; blob: Blob } {
  const doc = parseDocument(value);
  const blob = new Blob([JSON.stringify(doc)], { type: "application/json" });
  if (blob.size > maxBytes) throw new ExtractError("TOO_LARGE");
  return { doc, blob };
}
export function cleanUsage(usage: ProviderUsage | undefined): ProviderUsage | undefined {
  if (!usage) return undefined;
  const result: ProviderUsage = {};
  for (const field of ["inputTokens", "outputTokens", "credits"] as const) {
    const value = usage[field];
    if (value !== undefined) {
      if (!Number.isFinite(value) || value < 0 || value > Number.MAX_SAFE_INTEGER)
        throw new ExtractError("INVALID_OUTPUT");
      result[field] = value;
    }
  }
  return result;
}
/** Cursor is a UTF-8 byte offset. Reject mid-character offsets, preventing corrupt or duplicated text. */
export function textWindow(text: string | Uint8Array, cursor: number, maxBytes: number) {
  // Callers windowing one text many times (indexing) encode it once and pass bytes.
  const bytes = typeof text === "string" ? utf8(text) : text;
  integer(cursor, bytes.length);
  integer(maxBytes, LIMITS.readBytes, 1);
  if (cursor < bytes.length && (bytes[cursor] & 0xc0) === 0x80)
    throw new Error("INVALID_EXTRACT_CURSOR");
  let end = Math.min(cursor + maxBytes, bytes.length);
  while (end > cursor && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  if (end === cursor && cursor < bytes.length) throw new Error("EXTRACT_WINDOW_TOO_SMALL");
  return {
    text: new TextDecoder().decode(bytes.subarray(cursor, end)),
    cursor: end === bytes.length ? null : end,
    done: end === bytes.length,
  };
}
