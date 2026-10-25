/**
 * Pure provider-output validation, exact serialized sizing, and UTF-8 windows.
 * Workers use document on writes; readers trust the stored shape without copying pages.
 * These helpers keep payload memory and tool response sizes within shared limits.
 */
import { z } from "zod";
import { LIMITS, bounded, integer, utf8 } from "../shared/limits.js";
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
/**
 * Exact UTF-8 size of `JSON.stringify(text)`, computed without allocating the
 * output: quotes and backslash take 2 bytes, control characters 2 (\b \t \n
 * \f \r) or 6 (\u00XX), lone surrogates 6 (well-formed JSON escapes them),
 * everything else its UTF-8 width.
 */
function jsonStringBytes(text: string): number {
  let bytes = 2;

  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);

    if (code < 0x20)
      bytes += code === 8 || code === 9 || code === 10 || code === 12 || code === 13 ? 2 : 6;
    else if (code === 0x22 || code === 0x5c) bytes += 2;
    else if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = text.charCodeAt(index + 1);

      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else bytes += 6;
    } else if (code >= 0xdc00 && code <= 0xdfff) bytes += 6;
    else bytes += 3;
  }

  return bytes;
}
/** Exact UTF-8 size of `JSON.stringify(value)` for the plain values a document holds. */
function jsonBytes(value: unknown): number {
  if (typeof value === "string") return jsonStringBytes(value);

  if (typeof value === "number") return Number.isFinite(value) ? String(value).length : 4;

  if (typeof value === "boolean") return value ? 4 : 5;

  if (value === null) return 4;

  if (Array.isArray(value))
    return (
      2 + Math.max(0, value.length - 1) + value.reduce((sum, item) => sum + jsonBytes(item), 0)
    );

  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, item]) => item !== undefined,
    );

    return (
      2 +
      Math.max(0, entries.length - 1) +
      entries.reduce((sum, [key, item]) => sum + jsonStringBytes(key) + 1 + jsonBytes(item), 0)
    );
  }

  return 4;
}
/** Serialize only on writes; a read must not allocate another full 32 MiB JSON blob. */
export function document(value: unknown, maxBytes: number): { doc: ExtractedDoc; blob: Blob } {
  const doc = parseDocument(value);

  // Decide from the exact serialized size BEFORE `JSON.stringify` allocates: a
  // text near the input limit made of control characters escapes to six
  // characters each, and one non-Latin-1 character makes the whole output a
  // two-byte string (12x the input in memory). Past this check the string is at
  // most `maxBytes` characters, so at most 2 * maxBytes bytes.
  if (jsonBytes(doc) > maxBytes) throw new ExtractError("TOO_LARGE");

  const blob = new Blob([JSON.stringify(doc)], { type: "application/json" });

  if (blob.size > maxBytes) throw new ExtractError("TOO_LARGE");

  return { doc, blob };
}
/** Accept only finite nonnegative usage fields before crossing storage or accounting boundaries. */
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
