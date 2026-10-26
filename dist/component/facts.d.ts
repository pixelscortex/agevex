/** The tightest slot consumer accepts 128 UTF-8 bytes (meter/limits.ts:12).
 * Validate facts before admission, including when no optional slot is installed,
 * so adding a slot later cannot invalidate a previously accepted identity. */
export declare function assertFact(value: unknown, field: string, code?: string): asserts value is string;
/** A subject or agent name the component is about to store. Agent names are
 * repeated up to 1 + `LIMITS.sideAgents` times on one assignment (`agent` plus
 * every `reviewed` entry), so an unbounded name would grow the envelope nine
 * times over. Bounded in UTF-16 units: <=200 units is <=600 UTF-8 bytes. */
export declare function assertName(value: string, field: "subject" | "agent"): void;
/** A Convex function handle the component is about to store or run. Measured in
 * UTF-8 bytes, since that is what the stored row pays for. */
export declare function assertFunctionHandle(value: string, field: string): void;
