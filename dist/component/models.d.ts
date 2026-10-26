export declare const modelOverrides: import("convex/values").VRecord<Record<string, string>, import("convex/values").VString<string, "required">, import("convex/values").VString<string, "required">, "required", string>;
/** Runs are read once per queued row during cancel. Keep the entire map at
 * <=512 Convex bytes, reserving room alongside the run settings map in the
 * 16 KiB runs envelope. newRun also validates the complete JSON byte envelope. Character caps alone
 * cannot provide that guarantee for UTF-8 agent names and model ids.
 */
export declare function validModelOverrides(models: Record<string, string>): boolean;
