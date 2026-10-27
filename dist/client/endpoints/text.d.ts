import { type EndpointContext } from "./access.js";
/** Subscribe to the native thread title. */
export declare function titleEndpoint(ep: EndpointContext): import("convex/server").RegisteredQuery<"public", {
    threadId: string;
}, Promise<{
    text: string | null;
}>>;
/** The native title itself is the rename state. Repeated identical writes are
 * harmless, and an automatic title's atomic native check always respects it. */
export declare function renameEndpoint(ep: EndpointContext): import("convex/server").RegisteredMutation<"public", {
    threadId: string;
    text: string;
}, Promise<{
    messageId: string;
    replayed: boolean;
}>>;
