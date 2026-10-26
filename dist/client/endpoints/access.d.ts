import type { GenericDataModel, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { ComponentApi } from "../../component/_generated/component.js";
import type { SettingsSnapshot } from "../../component/run-settings.js";
import { type Limits } from "../../component/limits.js";
import type { AgentEvent, ManagedAgent, Registration } from "../types.js";
/** What every endpoint builder needs, resolved once per `authorizedEndpoints` call. */
export type EndpointContext = {
    component: ComponentApi;
    config: Registration;
    limits: Limits;
    settings: SettingsSnapshot;
    /** Every agent in the registered graph, by name: roots, children and side agents. */
    managedAgents: Map<string, ManagedAgent>;
};
/** The operations `ownedThread` authorizes; each is the host policy's `operation`. */
export type ThreadOperation = "title" | "rename" | "summary" | "summarize" | "send" | "respond" | "answer" | "cancel" | "messages" | "streams" | "activity";
/**
 * Resolve the endpoint context.
 *
 * A managed conversation is always a native thread, including a delegated
 * conversation. Index the entire registered graph so a persisted assignment's
 * agent name resolves to the correct native component for transcript reads.
 * Walk recursively rather than baking today's delegation-depth limit into the
 * reader, and visit shared agents once. Registration validates name uniqueness
 * and graph shape before these endpoints are constructed.
 */
export declare function createEndpointContext(component: ComponentApi, config: Registration, settings: SettingsSnapshot): EndpointContext;
/**
 * Resolve a public root agent by name, or throw `UNKNOWN_AGENT`.
 *
 * Opening a new public conversation still resolves roots only. Merely being
 * readable through an owned child thread must not expose a child as a root.
 */
export declare function rootAgent(ep: EndpointContext, name: string): ManagedAgent;
/**
 * Authorize one thread-scoped operation and return the owned assignment plus its
 * native agent. Throws `FORBIDDEN` for an unmanaged thread, a subject that does
 * not own it, or a root-only operation on a child thread.
 */
export declare function ownedThread(ep: EndpointContext, ctx: GenericQueryCtx<GenericDataModel>, threadId: string, operation: ThreadOperation): Promise<{
    native: ManagedAgent;
    assignmentId: string;
    threadId: string;
    subject: string;
    agent: string;
    root: boolean;
}>;
/** Report one lifecycle event to the host; never changes the request outcome. */
export declare function observe(ep: EndpointContext, ctx: GenericMutationCtx<GenericDataModel>, event: AgentEvent): Promise<void>;
