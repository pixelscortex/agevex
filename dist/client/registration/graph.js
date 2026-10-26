// The delegation graph of one registration.
//
// `resolveGraph` walks every root's `subagents` and `sideAgents` once, at
// `registerAgent` time, and rejects every shape the runtime cannot execute safely
// (cycles, depth, duplicates, reserved tool names, invalid side cadences). The
// coordinator, the turn runner, delivery and the host helpers resolve agent names
// through the resulting `Graph`. The public endpoints keep their own index
// (`endpoints/access.ts`), built from the same registration.
// Touches no tables; it is pure registration-time validation.
import { assertFact } from "../../component/facts.js";
import { LIMITS, resolveLimits } from "../../component/limits.js";
import { RESERVED_TOOL_NAMES } from "../tool-names.js";
/** Whether a value is an executable managed agent rather than a name-only entry. */
function isManagedAgent(value) {
    return (typeof value === "object" &&
        value !== null &&
        typeof value.name === "string" &&
        typeof value.streamText === "function" &&
        typeof value.component === "object" &&
        Array.isArray(value.subagents));
}
/**
 * Names of an agent's native deferred tools: tools without `execute` that the
 * provider does not own. Agent 0.7.7 saves them as unresolved calls that a human
 * approves or answers later (example/convex/chat/human.ts:125-157).
 *
 * Read at registration to bound how many approvals one pause can create, and at
 * the native-save seam (`turn/fence.ts`) so the component can record exactly
 * those calls without scanning the transcript.
 */
export function deferredToolNames(agent) {
    return Object.entries(agent.declaredTools)
        .filter(([, tool]) => !tool.execute && tool.type !== "provider")
        .map(([name]) => name);
}
/**
 * Validate the declared agent graph and resolve every delegation target.
 *
 * Rejected explicitly rather than tolerated: an unknown or name-only subagent
 * entry, a duplicate name bound to two different agents, a cycle, depth greater
 * than the host's maxDepth, a child that is also a public root, and any host
 * tool colliding with a reserved managed collaboration name. A child object does not need to be
 * listed in `Registration.agents`, so a shared definition stays non-public.
 */
export function resolveGraph(config) {
    const graph = { byName: new Map(), children: new Map(), edges: new Map() };
    const roots = new Set(config.agents.map((root) => root.name));
    if (roots.size !== config.agents.length)
        throw new Error("DUPLICATE_AGENT_NAME");
    const maxDepth = resolveLimits(config.limits).maxDepth;
    function visit(agent, depth, path) {
        assertAgentFits(graph, roots, maxDepth, agent, depth, path);
        graph.byName.set(agent.name, agent);
        if (depth)
            graph.children.set(agent.name, agent);
        graph.edges.set(agent.name, new Set(agent.subagents.map((child) => child.name)));
        // Walk every path, even through a shared object: its longest path must fit.
        const next = new Set(path).add(agent);
        const sides = agent.sideAgents ?? [];
        assertSideAgentSet(sides);
        for (const side of sides) {
            assertSideCadence(side);
            visit(side.agent, depth + 1, next);
        }
        for (const child of agent.subagents)
            visit(child, depth + 1, next);
    }
    for (const root of config.agents)
        visit(root, 0, new Set());
    if (graph.byName.size > LIMITS.agents)
        throw new Error("AGENT_LIMIT");
    return graph;
}
/**
 * Reject one visited agent that cannot join the graph at this position.
 *
 * Checked before the agent is recorded, in a fixed order so the thrown code is
 * deterministic: shape, sandbox opt-in, name fact, cycle, depth, root reuse,
 * duplicate name, reserved tool names.
 */
function assertAgentFits(graph, roots, maxDepth, agent, depth, path) {
    if (!isManagedAgent(agent))
        throw new Error("UNKNOWN_SUBAGENT");
    if (agent.sandbox !== undefined && typeof agent.sandbox !== "boolean")
        throw new Error("INVALID_SANDBOX_OPT_IN");
    assertFact(agent.name, "agent");
    if (path.has(agent))
        throw new Error("SUBAGENT_CYCLE");
    if (depth > maxDepth)
        throw new Error("SUBAGENT_DEPTH");
    if (depth && roots.has(agent.name))
        throw new Error("ROOT_AS_CHILD");
    const existing = graph.byName.get(agent.name);
    if (existing && existing !== agent)
        throw new Error("DUPLICATE_AGENT_NAME");
    if (RESERVED_TOOL_NAMES.some((name) => name in agent.declaredTools))
        throw new Error("RESERVED_TOOL_NAME");
}
/** At most `LIMITS.sideAgents` watchers per agent, each a distinct agent. */
function assertSideAgentSet(sides) {
    if (sides.length > LIMITS.sideAgents ||
        new Set(sides.map((side) => side.agent.name)).size !== sides.length)
        throw new Error("INVALID_SIDE_AGENTS");
}
/**
 * A side agent sees only the conversation delta, on exactly one cadence
 * (`turns` or `minutes`), a positive safe integer at most `LIMITS.cadence`.
 * The component's review admission relies on this single bounded cadence.
 */
function assertSideCadence(side) {
    const values = Object.values(side.every);
    if (side.sees !== "delta" ||
        values.length !== 1 ||
        !Number.isSafeInteger(values[0]) ||
        values[0] <= 0 ||
        values[0] > LIMITS.cadence ||
        !("turns" in side.every || "minutes" in side.every))
        throw new Error("INVALID_SIDE_CADENCE");
}
