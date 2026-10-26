import { type EndpointContext } from "./access.js";
/** `open`: start a new conversation with a public root agent. */
export declare function openEndpoint(ep: EndpointContext): import("convex/server").RegisteredMutation<"public", {
    models?: Record<string, string> | undefined;
    files?: string[] | undefined;
    agent: string;
    requestKey: string;
    prompt: string;
}, Promise<{
    status: "rejected";
    code: "INVALID_MESSAGE" | "INVALID_REQUEST_KEY";
} | {
    status: "rejected";
    code: "UNKNOWN_AGENT";
} | {
    status: "rejected";
    code: "INVALID_MODELS";
} | {
    status: "rejected";
    code: "KEY_CONFLICT";
} | {
    receiptId: string;
    status: "duplicate";
    assignmentId: string;
    threadId: string;
    position: number;
    code?: undefined;
} | {
    assignmentId: string;
    threadId: string;
    receiptId: string;
    status: "accepted";
    position: number;
} | {
    status: "rejected";
    code: "ATTACHMENT_LIMIT";
}>>;
/** `send`: the next user message in an owned root conversation. */
export declare function sendEndpoint(ep: EndpointContext): import("convex/server").RegisteredMutation<"public", {
    models?: Record<string, string> | undefined;
    files?: string[] | undefined;
    text: string;
    threadId: string;
    requestKey: string;
}, Promise<{
    status: "rejected";
    code: "INVALID_MESSAGE" | "INVALID_REQUEST_KEY";
} | {
    status: "rejected";
    code: "UNKNOWN_AGENT";
} | {
    status: "rejected";
    code: "INVALID_MODELS";
} | {
    status: "rejected";
    code: "KEY_CONFLICT";
} | {
    receiptId: string;
    status: "duplicate";
    assignmentId: string;
    threadId: string;
    position: number;
    code?: undefined;
} | {
    assignmentId: string;
    threadId: string;
    receiptId: string;
    status: "accepted";
    position: number;
} | {
    status: "rejected";
    code: "CANCELLED" | "RECOVERY_REQUIRED";
} | {
    status: "rejected";
    code: "QUEUE_FULL";
} | {
    status: "rejected";
    code: "ATTACHMENT_LIMIT";
}>>;
