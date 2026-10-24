/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as limits from "../limits.js";
import type * as queue from "../queue.js";
import type * as subagents from "../subagents.js";
import type * as ledger from "../ledger.js";
import type * as workflows from "../workflows.js";
import type * as worker from "../worker.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";
import { anyApi, componentsGeneric } from "convex/server";

const fullApi: ApiFromModules<{
  limits: typeof limits;
  ledger: typeof ledger;
  workflows: typeof workflows;
  queue: typeof queue;
  subagents: typeof subagents;
  worker: typeof worker;
}> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
> = anyApi as any;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
> = anyApi as any;

export const components = componentsGeneric() as unknown as {
  rootWorkflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"rootWorkflow">;
  childWorkflow: import("@convex-dev/workflow/_generated/component.js").ComponentApi<"childWorkflow">;
};
