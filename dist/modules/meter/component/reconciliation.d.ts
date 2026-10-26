/**
 * Indexed, on-demand discovery of saved request ids. Each batch leaves the
 * pending index before scheduling its successor, so the chain ends when empty.
 * This only schedules billing-evidence reads; it cannot invoke a model.
 */
import { v, type Infer } from "convex/values";
import type { MutationCtx } from "./_generated/server.js";
export declare const reconcileArgs: {
    subject: import("convex/values").VString<string, "required">;
    runId: import("convex/values").VString<string, "required">;
    providers: import("convex/values").VArray<{
        name: string;
        lookupMs: number;
    }[], import("convex/values").VObject<{
        name: string;
        lookupMs: number;
    }, {
        name: import("convex/values").VString<string, "required">;
        lookupMs: import("convex/values").VFloat64<number, "required">;
    }, "required", "name" | "lookupMs">, "required">;
    jobs: import("convex/values").VObject<{
        deliver?: string | undefined;
        lookup?: string | undefined;
        maxAttempts: number;
    }, {
        lookup: import("convex/values").VString<string | undefined, "optional">;
        deliver: import("convex/values").VString<string | undefined, "optional">;
        maxAttempts: import("convex/values").VFloat64<number, "required">;
    }, "required", "maxAttempts" | "deliver" | "lookup">;
};
/** Four full charges <=4*280 KiB, four patches and Workpool admissions <8 MiB.
 * Four charge index reads plus bounded Workpool admissions, independent of
 * root charge count; no transcript IO. */
export declare function reconcileRun(ctx: MutationCtx, args: Infer<ReturnType<typeof v.object<typeof reconcileArgs>>>): Promise<null>;
