// The resolved runtime context of one `registerAgent` call.
//
// `createRuntimeContext` runs every registration-time check (limits, graph, slot
// shapes, model allowlist, deferred tools, coordinator reference) in a fixed order
// and returns the immutable `RuntimeContext` that every runtime module receives
// explicitly as `rt`: the coordinator (`coordinate/`), the turn runner (`turn/`)
// and the trusted host helpers (`host/`). It also holds the two cross-cutting
// helpers they share: best-effort `observe` and the lazy coordinator reference.
// Touches no tables.
import { LIMITS, resolveLimits } from "../../component/limits.js";
import { deferredToolNames, resolveGraph } from "./graph.js";
/**
 * Validate one registration and resolve its runtime context.
 *
 * Called once by `registerAgent`. Every check throws a typed registration error
 * before any function is built, so a misconfigured host fails at import time
 * rather than mid-turn. The order of checks is part of the contract: it decides
 * which code a registration with several problems reports.
 */
export function createRuntimeContext(component, config) {
    const limits = resolveLimits(config.limits);
    const graph = resolveGraph(config);
    assertSlots(config);
    assertModelRegistration(config);
    assertDeferredTools(graph);
    const collaboration = [...graph.edges.values()].some((allowed) => allowed.size > 0) ||
        [...graph.byName.values()].some((agent) => agent.sideAgents?.length);
    const agentIndexes = new Map([...graph.byName.keys()].sort().map((name, index) => [name, index]));
    if (collaboration && !config.refs.coordinate)
        throw new Error("COORDINATE_REF_REQUIRED");
    const watching = [...graph.byName.values()].some((agent) => agent.sideAgents?.length);
    const rt = { component, config, limits, graph, agentIndexes, watching };
    return rt;
}
/** Every configured optional slot must expose the methods the runtime calls. */
function assertSlots(config) {
    for (const [slot, methods] of [
        [config.usage, ["scope"]],
        [config.budget, ["check"]],
        [config.telemetry, ["integration", "flush"]],
        [config.sandbox, ["tools"]],
        [config.extract, ["run", "tools"]],
    ]) {
        if (slot !== undefined &&
            (!slot ||
                methods.some((method) => typeof slot[method] !== "function")))
            throw new Error("INVALID_SLOT");
    }
}
/**
 * `models` and `modelAllowlist` come together, and the allowlist is bounded
 * (count, uniqueness, id length) because it is stored and compared per request.
 */
function assertModelRegistration(config) {
    if (!!config.models !== !!config.modelAllowlist ||
        (config.models !== undefined && typeof config.models !== "function") ||
        (config.modelAllowlist &&
            (config.modelAllowlist.length > LIMITS.modelAllowlist ||
                new Set(config.modelAllowlist).size !== config.modelAllowlist.length ||
                config.modelAllowlist.some((id) => !id || id.length > LIMITS.modelIdLength))))
        throw new Error("INVALID_MODEL_REGISTRATION");
}
/**
 * One model step can pause on every deferred tool at once, so each agent's
 * deferred tools must fit `LIMITS.approvalsPerPause`, and each name must fit the
 * request-key bound it is stored under.
 */
function assertDeferredTools(graph) {
    for (const agent of graph.byName.values()) {
        const deferred = deferredToolNames(agent);
        if (deferred.length > LIMITS.approvalsPerPause ||
            deferred.some((name) => !name || name.length > LIMITS.requestKeyLength))
            throw new Error("INVALID_DEFERRED_TOOLS");
    }
}
/** Report one lifecycle event to the host; observability never changes execution. */
export async function observe(rt, ctx, event) {
    try {
        await rt.config.observe?.(ctx, event);
    }
    catch {
        // Observability is best effort and must never change managed execution.
    }
}
/**
 * Resolve the host-supplied reference to this registration's coordinator.
 *
 * The registered builder (`coordinate/coordinator.ts`) is what the host exports;
 * `refs.coordinate` is the reference Convex can actually invoke. Both name the
 * same function, and `refs.coordinate` is required whenever collaboration is
 * configured (checked above), so resolving it lazily keeps a Main-only
 * registration free of a coordinator entirely.
 */
export function coordinateRef(rt) {
    return rt.config.refs.coordinate();
}
