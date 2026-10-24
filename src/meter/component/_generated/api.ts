/* eslint-disable */
/** Offline codegen equivalent; nested component APIs remain strongly typed. */
import { anyApi, componentsGeneric } from "convex/server";
import type { ApiFromModules, FilterApi, FunctionReference } from "convex/server";
import type * as charges from "../charges.js";
import type * as reads from "../reads.js";
type FullApi = ApiFromModules<{ charges: typeof charges; reads: typeof reads }>;
export const internal = anyApi as unknown as FilterApi<FullApi, FunctionReference<any, "internal">>;
export const components = componentsGeneric() as unknown as {
  costByThread: import("@convex-dev/aggregate/_generated/component.js").ComponentApi;
  costBySubject: import("@convex-dev/aggregate/_generated/component.js").ComponentApi;
  workpool: import("@convex-dev/workpool/_generated/component.js").ComponentApi;
};
