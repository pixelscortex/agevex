/**
 * Lazy credential option for meter host adapters.
 * Hosts whose rules forbid reading env at module init pass a getter; it runs
 * only when a sink delivers, never at construction. Each module keeps its own
 * copy because optional modules must not import one another.
 */
import { LIMITS } from "../shared/limits.js";
/** Resolve at call time and require a non-empty value within the byte bound. */
export async function resolveCredential(value, code) {
    const resolved = typeof value === "function" ? await value() : value;
    if (typeof resolved !== "string" ||
        !resolved ||
        new TextEncoder().encode(resolved).length > LIMITS.maxCredentialBytes)
        throw new Error(code);
    return resolved;
}
