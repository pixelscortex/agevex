import { type EndpointContext } from "./access.js";
/** `respond`: approve or deny one recorded approval request. Idempotent (`replayed`). */
export declare function respondEndpoint(ep: EndpointContext): import("convex/server").RegisteredMutation<"public", {
    reason?: string | undefined;
    threadId: string;
    approvalId: string;
    approved: boolean;
}, Promise<{
    messageId: string;
    replayed: boolean;
}>>;
/** `answer`: supply the result of one recorded deferred tool call. Idempotent (`replayed`). */
export declare function answerEndpoint(ep: EndpointContext): import("convex/server").RegisteredMutation<"public", {
    text: string;
    threadId: string;
    toolCallId: string;
}, Promise<{
    messageId: string;
    replayed: boolean;
}>>;
/** `cancel`: cancel the owned root thread's current request. */
export declare function cancelEndpoint(ep: EndpointContext): import("convex/server").RegisteredMutation<"public", {
    threadId: string;
}, Promise<null>>;
