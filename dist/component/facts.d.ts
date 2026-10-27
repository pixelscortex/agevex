/** Semantic slot facts accept 128 UTF-8 bytes (LIMITS.factBytes).
 * Validate facts before admission, including when no optional slot is installed,
 * so adding a slot later cannot invalidate a previously accepted identity. */
export declare function assertFact(value: unknown, field: string, code?: string): asserts value is string;
/** Bound names stored on assignments and run snapshots: <=200 UTF-16 units
 * is <=600 UTF-8 bytes. This keeps every metadata envelope finite. */
export declare function assertName(value: string, field: "subject" | "agent"): void;
/** A Convex function handle the component is about to store or run. Measured in
 * UTF-8 bytes, since that is what the stored row pays for. */
export declare function assertFunctionHandle(value: string, field: string): void;
