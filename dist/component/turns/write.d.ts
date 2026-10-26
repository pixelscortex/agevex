import { type ObjectType } from "convex/values";
import type { MutationCtx } from "../_generated/server.js";
export declare const writeArgs: {
    assignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
    executionId: import("convex/values").VString<string, "required">;
    cancellationEpoch: import("convex/values").VFloat64<number, "required">;
    handle: import("convex/values").VString<string, "required">;
    args: import("convex/values").VAny<any, "required", string>;
    rejectStale: import("convex/values").VBoolean<boolean | undefined, "optional">;
    nativeStream: import("convex/values").VString<string | undefined, "optional">;
    trackUsage: import("convex/values").VBoolean<boolean | undefined, "optional">;
    deferredTools: import("convex/values").VArray<string[] | undefined, import("convex/values").VString<string, "required">, "optional">;
    askUserTools: import("convex/values").VRecord<Record<string, {
        answerSchema?: any;
    }> | undefined, import("convex/values").VString<string, "required">, import("convex/values").VObject<{
        answerSchema?: any;
    }, {
        answerSchema: import("convex/values").VAny<any, "optional", string>;
    }, "required", "answerSchema" | `answerSchema.${string}`>, "optional", string>;
    nativeMessages: import("convex/values").VObject<{
        getMessages: string;
        finalizeMessage: string;
    } | undefined, {
        getMessages: import("convex/values").VString<string, "required">;
        finalizeMessage: import("convex/values").VString<string, "required">;
    }, "optional", "getMessages" | "finalizeMessage">;
};
type WriteArgs = ObjectType<typeof writeArgs>;
/** Run one native/tool mutation under the execution fence and record its
 * coordination facts. Returns the native mutation's result, or null (or a
 * typed CANCELLED error with `rejectStale`) when the caller lost the turn. */
export declare function fencedWrite(ctx: MutationCtx, args: WriteArgs): Promise<unknown>;
export {};
