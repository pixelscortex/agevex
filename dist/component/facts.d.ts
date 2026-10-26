/** The tightest slot consumer accepts 128 UTF-8 bytes (meter/limits.ts:12).
 * Validate facts before admission, including when no optional slot is installed,
 * so adding a slot later cannot invalidate a previously accepted identity. */
export declare function assertFact(value: unknown, field: string, code?: string): asserts value is string;
