import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import type * as artifacts from "../artifacts.js";
import type * as indexing from "../indexing.js";
import type * as workflows from "../workflows.js";
declare const fullApi: ApiFromModules<{
    artifacts: typeof artifacts;
    indexing: typeof indexing;
    workflows: typeof workflows;
}>;
export declare const api: FilterApi<typeof fullApi, FunctionReference<any, "public">>;
export declare const internal: FilterApi<typeof fullApi, FunctionReference<any, "internal">>;
export declare const components: {
    workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
export {};
