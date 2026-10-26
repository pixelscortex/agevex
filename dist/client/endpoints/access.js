// Shared context and ownership checks for the public endpoints.
//
// `createEndpointContext` indexes every registered agent once; `rootAgent`
// resolves a public root for `open`; `ownedThread` is the authorization gate every
// thread-scoped endpoint runs first: it loads the persisted assignment
// (`turns.send.assignment`), runs the host `authorize` policy, requires the returned
// subject to own the thread, and enforces which operations a child thread allows.
import { assertFact } from "../../component/facts.js";
import { resolveLimits } from "../../component/limits.js";
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
export function createEndpointContext(component, config, settings) {
    const limits = resolveLimits(config.limits);
    const managedAgents = new Map();
    function include(managed) {
        if (managedAgents.has(managed.name))
            return;
        managedAgents.set(managed.name, managed);
        for (const child of managed.subagents)
            include(child);
        for (const side of managed.sideAgents ?? [])
            include(side.agent);
    }
    for (const root of config.agents)
        include(root);
    return { component, config, limits, managedAgents, settings };
}
/**
 * Resolve a public root agent by name, or throw `UNKNOWN_AGENT`.
 *
 * Opening a new public conversation still resolves roots only. Merely being
 * readable through an owned child thread must not expose a child as a root.
 */
export function rootAgent(ep, name) {
    const found = ep.config.agents.find((a) => a.name === name);
    if (!found)
        throw new Error("UNKNOWN_AGENT");
    return found;
}
/**
 * Authorize one thread-scoped operation and return the owned assignment plus its
 * native agent. Throws `FORBIDDEN` for an unmanaged thread, a subject that does
 * not own it, or a root-only operation on a child thread.
 */
export async function ownedThread(ep, ctx, threadId, operation) {
    assertFact(threadId, "threadId");
    const row = await ctx.runQuery(ep.component.turns.send.assignment, { threadId });
    if (!row)
        throw new Error("FORBIDDEN");
    const trusted = await ep.config.authorize(ctx, { operation, agent: row.agent, threadId });
    assertFact(trusted.subject, "subject");
    if (trusted.subject !== row.subject)
        throw new Error("FORBIDDEN");
    // Ownership permits reading a child's transcript and resolving its recorded
    // approvals. Child turns belong to the coordinator's bounded delegation and
    // settlement path; accepting a public send could start another child turn
    // outside that path. Keep send and coordination reads (activity/delegations)
    // root-only; messages/respond use the same ownership check for every thread.
    // The role must come from the persisted assignment, not today's root names:
    // a later deployment can register a former child agent as a root without
    // changing the role of any existing child thread. A name-based check would
    // grant send/activity access to those old threads (and previously also let
    // a shared Agent object registered as both root and child bypass the guard).
    if (operation !== "messages" &&
        operation !== "streams" &&
        operation !== "respond" &&
        operation !== "answer" &&
        row.root === false)
        throw new Error("FORBIDDEN");
    const native = ep.managedAgents.get(row.agent);
    if (!native)
        throw new Error("UNKNOWN_AGENT");
    return { ...row, native };
}
/** Report one lifecycle event to the host; never changes the request outcome. */
export async function observe(ep, ctx, event) {
    try {
        await ep.config.observe?.(ctx, event);
    }
    catch {
        // Observability is best effort and must never change the request outcome.
    }
}
