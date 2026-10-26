/**
 * Lazy credential option for telemetry exporters.
 * Hosts whose rules forbid reading env at module init pass a getter; it runs
 * only when an export is attempted, never at construction. Each module keeps
 * its own copy because optional modules must not import one another.
 */
import { LIMITS, validateString } from "./limits.js";
/** Validate a literal at registration; a getter is validated when it resolves. */
export function checkCredential(value, name) {
    if (typeof value !== "function")
        validateString(value, name, LIMITS.maxConfigurationBytes);
}
/** Resolve at export time and apply the registration-time string validation. */
export async function resolveCredential(value, name) {
    const resolved = typeof value === "function" ? await value() : value;
    validateString(resolved, name, LIMITS.maxConfigurationBytes);
    return resolved;
}
