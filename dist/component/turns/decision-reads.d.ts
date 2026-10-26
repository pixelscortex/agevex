import { type QueryCtx } from "../_generated/server.js";
import type { Doc } from "../_generated/dataModel.js";
export declare const pendingItem: import("convex/values").VObject<{
    schema?: any;
    truncated?: true | undefined;
    id: string;
    kind: "ask" | "approval";
    agent: string;
    threadId: string;
    providerExecuted: boolean;
    toolCallId: string;
    tool: string;
    input: any;
}, {
    threadId: import("convex/values").VString<string, "required">;
    agent: import("convex/values").VString<string, "required">;
    kind: import("convex/values").VUnion<"ask" | "approval", [import("convex/values").VLiteral<"approval", "required">, import("convex/values").VLiteral<"ask", "required">], "required", never>;
    id: import("convex/values").VString<string, "required">;
    toolCallId: import("convex/values").VString<string, "required">;
    tool: import("convex/values").VString<string, "required">;
    input: import("convex/values").VAny<any, "required", string>;
    providerExecuted: import("convex/values").VBoolean<boolean, "required">;
    schema: import("convex/values").VAny<any, "optional", string>;
    truncated: import("convex/values").VLiteral<true | undefined, "optional">;
}, "required", "id" | "kind" | "agent" | "threadId" | "providerExecuted" | "toolCallId" | "tool" | "input" | "schema" | "truncated" | `input.${string}` | `schema.${string}`>;
/** One recorded reference reads one <=32 KiB proposal, never a native transcript. */
export declare function readPending(ctx: QueryCtx, row: Doc<"assignments">, request: NonNullable<Doc<"assignments">["approvals"]>["requests"][number]): Promise<{
    threadId: string;
    agent: string;
    kind: "ask" | "approval";
    schema?: any;
    truncated?: true | undefined;
    id: string;
    providerExecuted: boolean;
    toolCallId: string;
    tool: string;
    input: any;
}>;
/** Resolve exactly one requested decision, or the already committed first receipt. */
export declare const detail: import("convex/server").RegisteredQuery<"public", {
    id: string;
    deferred: boolean;
    subject: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<{
    threadId: string;
    agent: string;
    kind: "ask" | "approval";
    schema?: any;
    truncated?: true | undefined;
    id: string;
    providerExecuted: boolean;
    toolCallId: string;
    tool: string;
    input: any;
} | null>>;
/** Root plus bounded live children: <=59*32 KiB assignment metadata +
 * 256*32 KiB compact proposals + <=58*4 KiB child refs <10.1 MiB.
 * Native messages (up to 1 MiB of reasoning each) are never read here.
 * The host projects each item to <=16 KiB, giving <=4 MiB final output.
 */
export declare const pending: import("convex/server").RegisteredQuery<"public", {
    rootRunId?: string | undefined;
    subject: string;
    assignmentId: import("convex/values").GenericId<"assignments">;
}, Promise<{
    threadId: string;
    agent: string;
    kind: "ask" | "approval";
    schema?: any;
    truncated?: true | undefined;
    id: string;
    providerExecuted: boolean;
    toolCallId: string;
    tool: string;
    input: any;
}[]>>;
/** Edited input is retrieved only for the exact recorded call, within its assignment. */
export declare const effective: import("convex/server").RegisteredQuery<"public", {
    assignmentId: import("convex/values").GenericId<"assignments">;
    toolCallId: string;
}, Promise<any>>;
