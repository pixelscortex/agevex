import { type EndpointContext } from "./access.js";
/** One reactive query includes the owned root and its current live children. */
export declare function pendingApprovalsEndpoint(ep: EndpointContext): import("convex/server").RegisteredQuery<"public", {
    rootRunId?: string | undefined;
    threadId: string;
}, Promise<{
    schema?: any;
    question?: string | undefined;
    editable: boolean;
    threadId: string;
    agent: string;
    kind: "ask" | "approval";
    truncated?: true | undefined;
    id: string;
    providerExecuted: boolean;
    toolCallId: string;
    tool: string;
    input: any;
}[]>>;
