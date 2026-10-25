import { ConvexError } from "convex/values";
import { LIMITS } from "./limits.js";

/** The tightest slot consumer accepts 128 UTF-8 bytes (meter/limits.ts:12).
 * Validate facts before admission, including when no optional slot is installed,
 * so adding a slot later cannot invalidate a previously accepted identity. */
export function assertFact(
  value: unknown,
  field: string,
  code = `INVALID_${field.toUpperCase()}`,
): asserts value is string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    new TextEncoder().encode(value).byteLength > LIMITS.factBytes
  )
    throw new ConvexError({ code, field });
}
