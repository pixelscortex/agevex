import type { ComponentApi } from "../component/_generated/component.js";
import { type Breakdown } from "../shared/breakdowns.js";
import type { ResolvedLimits } from "../shared/limits.js";
import type { Attribution, MeterOptions, ReadCtx, Sink } from "./types.js";
export type MeterContext = {
    component: ComponentApi;
    options: MeterOptions;
    limits: ResolvedLimits;
    breakdowns: Breakdown[];
    sinks: (Sink & {
        name: string;
    })[];
};
/** Resolve registration once, preserving validation order before any host operation. */
export declare function resolveMeter(component: ComponentApi, options: MeterOptions): MeterContext;
/** Find only own provider registrations; unknown names must remain billable unknowns. */
export declare function registered({ options }: MeterContext, name: string): import("./types.js").Provider | undefined;
/** Require a provider for read-only lookup work after its job fence has passed. */
export declare function providerFor(meter: MeterContext, name: string): import("./types.js").Provider;
/** Resolve worker handles per call, keeping lookup before delivery as in registration. */
export declare function jobs({ options, limits }: MeterContext): Promise<{
    deliver?: import("convex/server").FunctionHandle<"action", any, any> | undefined;
    lookup?: import("convex/server").FunctionHandle<"action", any, any> | undefined;
    maxAttempts: number;
}>;
/** Validate all attribution labels before invoking the host guard on standalone calls. */
export declare function authorize({ options }: MeterContext, ctx: ReadCtx, attribution: Partial<Attribution>): Promise<void>;
