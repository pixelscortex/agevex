/** Stable JSON identities and conservative JSON/Convex envelope measurements. */
import { getConvexSize, type Value } from "convex/values";

/** Object order is transport detail; arrays retain their original order. */
export function canonicalJson(value: unknown): string {
  const canonical = (part: unknown): unknown =>
    Array.isArray(part)
      ? part.map(canonical)
      : part && typeof part === "object"
        ? Object.fromEntries(
            Object.entries(part)
              .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : part;

  return JSON.stringify(canonical(value));
}

/** Encoded strings include quotes/escapes; raw UTF-8 guards stay separate.
 * Decimal bigint JSON preserves the existing run-envelope measurement. */
export function valueBytes(value: unknown): number {
  return Math.max(
    getConvexSize(value as Value),
    new TextEncoder().encode(
      JSON.stringify(value, (_key, part) => (typeof part === "bigint" ? part.toString() : part)),
    ).byteLength,
  );
}
