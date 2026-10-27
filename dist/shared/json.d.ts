/** Object order is transport detail; arrays retain their original order. */
export declare function canonicalJson(value: unknown): string;
/** Encoded strings include quotes/escapes; raw UTF-8 guards stay separate.
 * Decimal bigint JSON preserves the existing run-envelope measurement. */
export declare function valueBytes(value: unknown): number;
