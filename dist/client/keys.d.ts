/** Stable JSON for fingerprints: object property order is not part of an input. */
export declare function fingerprint(input: unknown): Promise<string>;
/** Opaque identities are full SHA-256 hex: exactly 64 ASCII bytes. Hash a
 * canonical array of domain-separated parts, never concatenated raw ids. This
 * keeps every identity within the slot key-size ceiling,
 * while remaining identical across Workflow/receipt replay. */
export declare const opaqueKey: (...parts: unknown[]) => Promise<string>;
