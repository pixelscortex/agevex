import type { MutationCtx } from "../_generated/server.js";
import type { AskUserMetadata } from "../../shared/tool-markers.js";
export declare const proposal: import("convex/values").VObject<{
    schema?: any;
    truncated?: true | undefined;
    id: string;
    providerExecuted: boolean;
    toolCallId: string;
    tool: string;
    input: any;
}, {
    id: import("convex/values").VString<string, "required">;
    toolCallId: import("convex/values").VString<string, "required">;
    tool: import("convex/values").VString<string, "required">;
    input: import("convex/values").VAny<any, "required", string>;
    providerExecuted: import("convex/values").VBoolean<boolean, "required">;
    schema: import("convex/values").VAny<any, "optional", string>;
    truncated: import("convex/values").VLiteral<true | undefined, "optional">;
}, "required", "id" | "providerExecuted" | "toolCallId" | "tool" | "input" | "schema" | "truncated" | `input.${string}` | `schema.${string}`>;
/** Bound the copied proposal, never the containing native reasoning/text message.
 * At most 16*32 KiB extra writes per save; every proposal fits well below 1 MiB.
 * Huge native identifiers still support cancellation through the exact native
 * ref; their pending stub uses a fixed-size hash rather than copying megabytes.
 */
export declare function saveProposal(ctx: MutationCtx, call: {
    toolCallId: string;
    toolName: string;
    input?: unknown;
    providerExecuted?: boolean;
}, id: string, metadata?: AskUserMetadata): Promise<import("convex/values").GenericId<"receipts">>;
