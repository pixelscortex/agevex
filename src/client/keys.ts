/** Stable JSON for fingerprints: object property order is not part of an input. */
export async function fingerprint(input: unknown): Promise<string> {
  const canonical = (value: unknown): unknown =>
    Array.isArray(value)
      ? value.map(canonical)
      : value && typeof value === "object"
        ? Object.fromEntries(
            Object.entries(value)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([k, v]) => [k, canonical(v)]),
          )
        : value;
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(JSON.stringify(canonical(input))),
  );
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Opaque identities are full SHA-256 hex: exactly 64 ASCII bytes. Hash a
 * canonical array of domain-separated parts, never concatenated raw ids. This
 * avoids meter's reserved :delta: segment and every slot's key-size ceiling,
 * while remaining identical across Workflow/receipt replay. */
export const opaqueKey = (...parts: unknown[]) => fingerprint(parts);
