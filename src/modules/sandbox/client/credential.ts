/**
 * Lazy credential option for the Daytona adapter.
 * Hosts whose rules forbid reading env at module init pass a getter; it runs
 * only when a Daytona call is made, never at construction. Each module keeps
 * its own copy because optional modules must not import one another.
 */
import { LIMITS } from "../shared/limits.js";

/** A literal secret, or a getter (sync or async) called at each use. */
export type Credential = string | (() => string | Promise<string>);

/** Resolve at call time and require a non-empty value within the length bound. */
export async function resolveCredential(value: Credential, code: string): Promise<string> {
  const resolved = typeof value === "function" ? await value() : value;

  if (typeof resolved !== "string" || !resolved || resolved.length > LIMITS.credentialChars)
    throw new Error(code);

  return resolved;
}
