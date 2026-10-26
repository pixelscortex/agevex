/**
 * Validation of identity "facts" (subject, thread id, ...) that hosts pass in
 * and that optional slot components later receive. Used by files/attachments.ts and the
 * client's endpoints before admission. Also the component-side writer bounds
 * for stored names and function handles, which keep the assignment envelope
 * (limits.ts `assignmentBytes`) independent of host string lengths.
 */
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

/** Bound names stored on assignments and run snapshots: <=200 UTF-16 units
 * is <=600 UTF-8 bytes. This keeps every metadata envelope finite. */
export function assertName(value: string, field: "subject" | "agent") {
  if (!value || value.length > LIMITS.nameLength)
    throw new ConvexError({ code: `INVALID_${field.toUpperCase()}`, field });
}

/** A Convex function handle the component is about to store or run. Measured in
 * UTF-8 bytes, since that is what the stored row pays for. */
export function assertFunctionHandle(value: string, field: string) {
  if (!value || new TextEncoder().encode(value).byteLength > LIMITS.functionHandleBytes)
    throw new ConvexError({ code: "INVALID_FUNCTION_HANDLE", field });
}
