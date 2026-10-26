import type { ApiFromModules } from "convex/server";
import type * as state from "../state.js";
export declare const api: ApiFromModules<{
    state: typeof state;
}>;
