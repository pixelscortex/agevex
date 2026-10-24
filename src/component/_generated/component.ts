/* eslint-disable */
/**
 * Offline equivalent of Convex's generated component surface. Only public
 * component functions cross the mount boundary; internal Workflow functions
 * stay private. Component-local branded ids become strings in the host app.
 * Deriving the signatures keeps this checked-in bridge in sync until the next
 * deployment runs normal component codegen.
 */
import type { ApiFromModules, FunctionReference } from "convex/server";
import type { GenericId } from "convex/values";
import type * as queue from "../queue.js";
import type * as subagents from "../subagents.js";
import type * as ledger from "../ledger.js";
import type * as cancellation from "../cancellation.js";

type Wire<T> = T extends GenericId<string>
  ? string
  : T extends readonly unknown[]
    ? { [K in keyof T]: Wire<T[K]> }
    : T extends object
      ? { [K in keyof T]: Wire<T[K]> }
      : T;

type Exposed<T, Name extends string | undefined> = {
  [K in keyof T as T[K] extends FunctionReference<any, "public">
    ? K
    : T[K] extends FunctionReference<any>
      ? never
      : K]: T[K] extends FunctionReference<infer Type, "public", infer Args, infer Result>
    ? FunctionReference<Type, "internal", Wire<Args>, Wire<Result>, Name>
    : Exposed<T[K], Name>;
};

export type ComponentApi<Name extends string | undefined = string | undefined> = Exposed<
  ApiFromModules<{
    cancellation: typeof cancellation;
    queue: typeof queue;
    subagents: typeof subagents;
    ledger: typeof ledger;
  }>,
  Name
>;
