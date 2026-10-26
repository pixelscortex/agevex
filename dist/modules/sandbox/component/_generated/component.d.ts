/** Offline component boundary: local ids are strings in the mounting host. */
import type { ApiFromModules, FunctionReference } from "convex/server";
import type { GenericId } from "convex/values";
import type * as state from "../state.js";
type Wire<T> = T extends GenericId<string> ? string : T extends readonly unknown[] ? {
    [K in keyof T]: Wire<T[K]>;
} : T extends object ? {
    [K in keyof T]: Wire<T[K]>;
} : T;
type Exposed<T, Name extends string | undefined> = {
    [K in keyof T]: T[K] extends FunctionReference<infer Kind, "public", infer Args, infer Result> ? FunctionReference<Kind, "internal", Wire<Args>, Wire<Result>, Name> : Exposed<T[K], Name>;
};
export type ComponentApi<Name extends string | undefined = string | undefined> = Exposed<ApiFromModules<{
    state: typeof state;
}>, Name>;
export {};
