// The resolved runtime context of one `registerAgent` call.
//
// `createRuntimeContext` runs every registration-time check (limits, graph, slot
// shapes, model allowlist, deferred tools, coordinator reference) in a fixed order
// and returns the immutable `RuntimeContext` that every runtime module receives
// explicitly as `rt`: the coordinator (`coordinate/`), the turn runner (`turn/`)
// and the trusted host helpers (`host/`). It also holds the two cross-cutting
// helpers they share: best-effort `observe` and the lazy coordinator reference.
// Touches no tables.

import type { GenericActionCtx, GenericDataModel, GenericMutationCtx } from "convex/server";
import type { ComponentApi } from "../../component/_generated/component.js";
import { LIMITS, resolveLimits, type Limits } from "../../component/limits.js";
import {
  assertSettingsSnapshot,
  resolveRunSettings,
  type SettingsSnapshot,
} from "../../component/run_settings.js";
import { assertTextOptions } from "../text/options.js";
import type { AgentEvent, Registration } from "../types.js";
import { deferredToolNames, resolveGraph, type Graph } from "./graph.js";

/** Mutation context the coordinator runs with; also what native saves accept. */
export type CoordinatorCtx = GenericMutationCtx<GenericDataModel>;

/** Action context the host runner finalizes a turn with. */
export type RunnerCtx = GenericActionCtx<GenericDataModel>;

/** Everything a runtime module needs from one registration, resolved once. */
export type RuntimeContext = {
  component: ComponentApi;
  config: Registration;
  /** Host limits merged over `LIMITS` and validated. */
  limits: Limits;
  graph: Graph;
  settings: SettingsSnapshot;
};

/**
 * Validate one registration and resolve its runtime context.
 *
 * Called once by `registerAgent`. Every check throws a typed registration error
 * before any function is built, so a misconfigured host fails at import time
 * rather than mid-turn. The order of checks is part of the contract: it decides
 * which code a registration with several problems reports.
 */
export function createRuntimeContext(component: ComponentApi, config: Registration) {
  const limits = resolveLimits(config.limits);
  const graph = resolveGraph(config);

  const settings = [...graph.byName].map(([name, agent]) => {
    const resolved = resolveRunSettings({
      ...agent.run,
      ...(agent.askUser !== undefined ? { askUser: agent.askUser } : {}),
    });

    // Retain the existing host default while allowing an explicit per-agent
    // step count. Resolve the raw run object first so malformed JS fails too.
    if (agent.run?.stepsPerTurn === undefined) resolved.stepsPerTurn = limits.slicesPerTurn;

    return { agent: name, settings: resolved };
  });

  assertSettingsSnapshot(settings);
  assertSlots(config);
  assertModelRegistration(config);
  assertDeferredTools(graph);
  assertTextOptions(config);

  const collaboration = [...graph.edges.values()].some((allowed) => allowed.size > 0);

  if (collaboration && !config.refs.coordinate) throw new Error("COORDINATE_REF_REQUIRED");

  const rt: RuntimeContext = { component, config, limits, graph, settings };

  return rt;
}

/** Every configured optional slot must expose the methods the runtime calls. */
function assertSlots(config: Registration) {
  for (const [slot, methods] of [
    [config.usage, ["record"]],
    [config.budget, ["check"]],
    [config.telemetry, ["integration", "flush"]],
    [config.sandbox, ["tools"]],
  ] as const) {
    if (
      slot !== undefined &&
      (!slot ||
        methods.some(
          (method) => typeof (slot as unknown as Record<string, unknown>)[method] !== "function",
        ))
    )
      throw new Error("INVALID_SLOT");
  }
}

/**
 * `models` and `modelAllowlist` come together, and the allowlist is bounded
 * (count, uniqueness, id length) because it is stored and compared per request.
 */
function assertModelRegistration(config: Registration) {
  if (
    !!config.models !== !!config.modelAllowlist ||
    (config.models !== undefined && typeof config.models !== "function") ||
    (config.modelAllowlist &&
      (config.modelAllowlist.length > LIMITS.modelAllowlist ||
        new Set(config.modelAllowlist).size !== config.modelAllowlist.length ||
        config.modelAllowlist.some((id) => !id || id.length > LIMITS.modelIdLength)))
  )
    throw new Error("INVALID_MODEL_REGISTRATION");
}

/**
 * One model step can pause on every deferred tool at once, so each agent's
 * deferred tools must fit `LIMITS.approvalsPerPause`, and each name must fit the
 * request-key bound it is stored under.
 */
function assertDeferredTools(graph: Graph) {
  for (const agent of graph.byName.values()) {
    const deferred = deferredToolNames(agent);

    if (
      deferred.length > LIMITS.approvalsPerPause ||
      deferred.some((name) => !name || name.length > LIMITS.requestKeyLength)
    )
      throw new Error("INVALID_DEFERRED_TOOLS");
  }
}

/** Report one lifecycle event to the host; observability never changes execution. */
export async function observe(
  rt: RuntimeContext,
  ctx: CoordinatorCtx | RunnerCtx,
  event: AgentEvent,
): Promise<void> {
  try {
    await rt.config.observe?.(ctx, event);
  } catch {
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
export function coordinateRef(rt: RuntimeContext) {
  return rt.config.refs.coordinate!();
}
