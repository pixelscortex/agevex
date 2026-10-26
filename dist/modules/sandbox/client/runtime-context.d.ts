/**
 * Validated host runtime context, identity checks and shared action deadlines.
 * Lifecycle, tools and watchdog builders share this context and its deadline map.
 * Authorization remains host-owned; usage recording cannot turn success into failure.
 */
import { type GenericMutationCtx, type GenericDataModel } from "convex/server";
import { type SandboxLimits } from "../shared/limits.js";
import { type SandboxContext, type SandboxFacts, type SandboxOptions, type SandboxAuthorization, type SandboxUsageEvent } from "./types.js";
export type RuntimeContext = {
    options: SandboxOptions;
    limits: SandboxLimits;
    component: SandboxOptions["component"];
    provider: SandboxOptions["provider"];
    nodeExport: boolean;
    deadlines: WeakMap<SandboxContext, number>;
};
/** Validate host configuration once; all builders receive this shared action budget. */
export declare function createRuntimeContext(options: SandboxOptions, nodeExport: boolean): RuntimeContext;
/** Start or read this action context’s shared deadline before any provider work. */
export declare function remaining(runtime: RuntimeContext, ctx: SandboxContext): number;
/** One shared <=540 s budget, leaving 60 s below Convex's action ceiling. */
export declare function within<T>(runtime: RuntimeContext, ctx: SandboxContext, invoke: () => Promise<T>, budgetMs?: number): Promise<T>;
/** A separate finite kill budget survives an exhausted poll/action deadline. */
export declare function kill(runtime: RuntimeContext, ctx: SandboxContext, jobId: string, location: Parameters<RuntimeContext["provider"]["cancelBackground"]>[2]): Promise<boolean>;
/** Validate trusted attribution before keying a scope, admitting a receipt or storing metadata. */
export declare function facts(tc: SandboxFacts): {
    subject: string;
    threadId: string;
    runId: string;
};
/** Stable subject-isolated key; request bodies and model arguments are never part of binding. */
export declare function scopeKey(runtime: RuntimeContext, tc: SandboxFacts): Promise<string>;
/** Recheck host policy and reject any mismatch with the already-bound subject. */
export declare function authorize(runtime: RuntimeContext, ctx: SandboxContext | GenericMutationCtx<GenericDataModel>, request: SandboxAuthorization): Promise<{
    subject: string;
}>;
/** Record best-effort usage after an effect, keeping accounting failures out of effect outcomes. */
export declare function observe(runtime: RuntimeContext, ctx: SandboxContext, sandboxId: string | undefined, operation: SandboxUsageEvent["operation"], outcome: SandboxUsageEvent["outcome"], tc?: SandboxFacts): Promise<void>;
/** True while at least `minMs` of this action's shared budget remains. */
export declare function hasBudget(runtime: RuntimeContext, ctx: SandboxContext, minMs: number): boolean;
