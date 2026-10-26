/**
 * Lazy credential and setting options for telemetry exporters.
 * Hosts whose rules forbid reading env at module init pass a getter; it runs
 * only when an export is attempted, never at construction. Each module keeps
 * its own copy because optional modules must not import one another.
 */
import { LIMITS, validateString } from "./limits.js";
/** Validate a literal at registration; a getter is validated when it resolves. */
export function checkCredential(value, name) {
    checkSetting(value, name, LIMITS.maxConfigurationBytes);
}
/** Resolve at export time and apply the registration-time string validation. */
export function resolveCredential(value, name) {
    return resolveSetting(value, name, LIMITS.maxConfigurationBytes);
}
/** Validate a literal setting at construction; a getter is validated when it resolves. */
export function checkSetting(value, name, maximum) {
    if (typeof value !== "function")
        validateString(value, name, maximum);
}
/** Resolve at export time; a missing or oversized value throws into the fail-open attempt. */
export async function resolveSetting(value, name, maximum) {
    const resolved = typeof value === "function" ? await value() : value;
    validateString(resolved, name, maximum);
    return resolved;
}
