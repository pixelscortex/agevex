import type { ManagedAgent, Registration } from "../types.js";
/** Resolved, validated delegation graph built once at registration. */
export type Graph = {
    /** Every executable managed agent, roots and shared children alike. */
    byName: Map<string, ManagedAgent>;
    /** Child agent objects, keyed by the name a delegation request uses. */
    children: Map<string, ManagedAgent>;
    /** Which child names a root may delegate to. */
    edges: Map<string, ReadonlySet<string>>;
};
/**
 * Names of an agent's native deferred tools: tools without `execute` that the
 * provider does not own. Agent 0.7.7 saves them as unresolved calls that a human
 * approves or answers later (example/convex/chat/human.ts:125-157).
 *
 * Read at registration to bound how many approvals one pause can create, and at
 * the native-save seam (`turn/fence.ts`) so the component can record exactly
 * those calls without scanning the transcript.
 */
export declare function deferredToolNames(agent: ManagedAgent): string[];
/**
 * Validate the declared agent graph and resolve every delegation target.
 *
 * Rejected explicitly rather than tolerated: an unknown or name-only subagent
 * entry, a duplicate name bound to two different agents, a cycle, depth greater
 * than the host's maxDepth, a child that is also a public root, and any host
 * tool colliding with a reserved managed collaboration name. A child object does not need to be
 * listed in `Registration.agents`, so a shared definition stays non-public.
 */
export declare function resolveGraph(config: Registration): Graph;
