import type { GenericActionCtx, GenericDataModel, GenericMutationCtx } from "convex/server";
import type { ComponentApi } from "../../component/_generated/component.js";
import { type Limits } from "../../component/limits.js";
import { type SettingsSnapshot } from "../../component/run_settings.js";
import type { AgentEvent, Registration } from "../types.js";
import { type Graph } from "./graph.js";
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
export declare function createRuntimeContext(component: ComponentApi, config: Registration): RuntimeContext;
/** Report one lifecycle event to the host; observability never changes execution. */
export declare function observe(rt: RuntimeContext, ctx: CoordinatorCtx | RunnerCtx, event: AgentEvent): Promise<void>;
/**
 * Resolve the host-supplied reference to this registration's coordinator.
 *
 * The registered builder (`coordinate/coordinator.ts`) is what the host exports;
 * `refs.coordinate` is the reference Convex can actually invoke. Both name the
 * same function, and `refs.coordinate` is required whenever collaboration is
 * configured (checked above), so resolving it lazily keeps a Main-only
 * registration free of a coordinator entirely.
 */
export declare function coordinateRef(rt: RuntimeContext): import("convex/server").FunctionReference<"mutation", "internal", import("../types.js").CoordinateArgs, import("../types.js").CoordinateResult>;
