/* Offline codegen equivalent, matching the core component's checked-in bridge. */
import { anyApi, componentsGeneric } from "convex/server";
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import type * as artifacts from "../artifacts.js";
import type * as indexing from "../indexing.js";
import type * as workflows from "../workflows.js";
const fullApi = anyApi as unknown as ApiFromModules<{ artifacts: typeof artifacts; indexing: typeof indexing; workflows: typeof workflows }>;
export const api = fullApi as FilterApi<typeof fullApi, FunctionReference<any, "public">>;
export const internal = fullApi as FilterApi<typeof fullApi, FunctionReference<any, "internal">>;
export const components = componentsGeneric() as unknown as {
  workflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"workflow">;
};
