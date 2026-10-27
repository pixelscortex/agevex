/**
 * Lazy credential option for the Daytona adapter.
 * Hosts whose rules forbid reading env at module init pass a getter; it runs
 * only when a Daytona call is made, never at construction.
 */
import { LIMITS } from "../shared/limits.js";
/** Resolve at call time and require a non-empty value within the length bound. */
export async function resolveCredential(value, code) {
    const resolved = typeof value === "function" ? await value() : value;
    if (typeof resolved !== "string" || !resolved || resolved.length > LIMITS.credentialChars)
        throw new Error(code);
    return resolved;
}
