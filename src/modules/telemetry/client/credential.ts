/**
 * Lazy credential option for telemetry exporters.
 * Hosts whose rules forbid reading env at module init pass a getter; it runs
 * only when an export is attempted, never at construction. Each module keeps
 * its own copy because optional modules must not import one another.
 */
import { LIMITS, validateString } from "./limits.js";

/** A literal secret, or a getter (sync or async) called at each export. */
export type Credential = string | (() => string | Promise<string>);

/** Validate a literal at registration; a getter is validated when it resolves. */
export function checkCredential(value: Credential, name: string): void {
  if (typeof value !== "function") validateString(value, name, LIMITS.maxConfigurationBytes);
}

/** Resolve at export time and apply the registration-time string validation. */
export async function resolveCredential(value: Credential, name: string): Promise<string> {
  const resolved = typeof value === "function" ? await value() : value;

  validateString(resolved, name, LIMITS.maxConfigurationBytes);

  return resolved;
}
