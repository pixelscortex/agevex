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
    deferredTools: import("convex/values").VArray<string[] | undefined, import("convex/values").VString<string, "required">, "optional">;
    askUserTools: import("convex/values").VRecord<Record<string, {
        calls: {
            error?: string | undefined;
            input?: any;
            answerSchema?: any;
            toolCallId: string;
        }[];
    }> | undefined, import("convex/values").VString<string, "required">, import("convex/values").VObject<{
        calls: {
            error?: string | undefined;
            input?: any;
            answerSchema?: any;
            toolCallId: string;
        }[];
    }, {
        calls: import("convex/values").VArray<{
            error?: string | undefined;
            input?: any;
            answerSchema?: any;
            toolCallId: string;
        }[], import("convex/values").VObject<{
            error?: string | undefined;
            input?: any;
            answerSchema?: any;
            toolCallId: string;
        }, {
            toolCallId: import("convex/values").VString<string, "required">;
            input: import("convex/values").VAny<any, "optional", string>;
            answerSchema: import("convex/values").VAny<any, "optional", string>;
            error: import("convex/values").VString<string | undefined, "optional">;
        }, "required", "error" | "toolCallId" | "input" | `input.${string}` | "answerSchema" | `answerSchema.${string}`>, "required">;
    }, "required", "calls">, "optional", string>;
    nativeMessages: import("convex/values").VObject<{
        getMessages: string;
        finalizeMessage: string;
        failMessage: string;
    } | undefined, {
        getMessages: import("convex/values").VString<string, "required">;
        finalizeMessage: import("convex/values").VString<string, "required">;
        failMessage: import("convex/values").VString<string, "required">;
    }, "optional", "getMessages" | "finalizeMessage" | "failMessage">;
};
type WriteArgs = ObjectType<typeof writeArgs>;
/** Run one native/tool mutation under the execution fence and record its
 * coordination facts. Returns the native mutation's result, or null (or a
 * typed CANCELLED error with `rejectStale`) when the caller lost the turn. */
export declare function fencedWrite(ctx: MutationCtx, args: WriteArgs): Promise<unknown>;
export {};
