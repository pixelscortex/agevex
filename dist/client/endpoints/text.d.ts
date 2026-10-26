import { type EndpointContext } from "./access.js";
/** Subscribe to the native title and its optimistic rename version. */
export declare function titleEndpoint(ep: EndpointContext): import("convex/server").RegisteredQuery<"public", {
    threadId: string;
}, Promise<{
    text: string | null;
    source: "user" | "auto" | null;
    version: number;
}>>;
/** Repeated identical renames replay once; conflicting versions never overwrite. */
export declare function renameEndpoint(ep: EndpointContext): import("convex/server").RegisteredMutation<"public", {
    text: string;
    threadId: string;
    expectedVersion: number;
}, Promise<{
    messageId: string;
    replayed: boolean;
}>>;
/** Summary text is display-only; native context remains unchanged. */
export declare function summaryEndpoint(ep: EndpointContext): import("convex/server").RegisteredQuery<"public", {
    threadId: string;
}, Promise<{
    text: string;
    throughMessageId: string;
} | null>>;
/** Explicit request keys dedupe queued work; no action waits for the model. */
export declare function summarizeEndpoint(ep: EndpointContext): import("convex/server").RegisteredMutation<"public", {
    threadId: string;
    requestKey: string;
}, Promise<{
    status: "replayed";
} | {
    status: "queued";
}>>;
