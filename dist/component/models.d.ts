export declare const modelOverrides: import("convex/values").VRecord<Record<string, string>, import("convex/values").VString<string, "required">, import("convex/values").VString<string, "required">, "required", string>;
/** Runs are read once per queued row during cancel. Keep the entire map at
 * <=512 bytes so each run, including its native envelope and counters, remains
 * <=1 KiB in the existing 3I*1 KiB cancellation budget. Character caps alone
 * cannot provide that guarantee for UTF-8 agent names and model ids.
 */
export declare function validModelOverrides(models: Record<string, string>): boolean;
