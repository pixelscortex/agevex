/* eslint-disable */
/** Same offline public-to-internal mount bridge used by the core component. */
import type { ApiFromModules, FunctionReference } from "convex/server";
import type { GenericId } from "convex/values";
import type * as charges from "../charges.js";
import type * as reads from "../reads.js";
type Wire<T> = T extends GenericId<string> ? string : T extends readonly unknown[]
  ? { [K in keyof T]: Wire<T[K]> } : T extends object ? { [K in keyof T]: Wire<T[K]> } : T;
type Exposed<T, Name extends string | undefined> = {
  [K in keyof T as T[K] extends FunctionReference<any, "public"> ? K
    : T[K] extends FunctionReference<any> ? never : K]:
    T[K] extends FunctionReference<infer F, "public", infer A, infer R>
      ? FunctionReference<F, "internal", Wire<A>, Wire<R>, Name> : Exposed<T[K], Name>;
};
export type ComponentApi<Name extends string | undefined = string | undefined> = Exposed<
  ApiFromModules<{ charges: typeof charges; reads: typeof reads }>, Name>;
