import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import type * as charges from "../charges.js";
import type * as reads from "../reads.js";
type FullApi = ApiFromModules<{
    charges: typeof charges;
    reads: typeof reads;
}>;
export declare const internal: FilterApi<FullApi, FunctionReference<any, "internal">>;
export declare const components: {
    costByThread: import("@convex-dev/aggregate/_generated/component.js").ComponentApi;
    costBySubject: import("@convex-dev/aggregate/_generated/component.js").ComponentApi;
    workpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi;
};
export {};
