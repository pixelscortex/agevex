/** Offline generated bridge; regenerate with normal Convex component codegen. */
import { anyApi } from "convex/server";
import type { ApiFromModules } from "convex/server";
import type * as state from "../state.js";
export const api = anyApi as unknown as ApiFromModules<{ state: typeof state }>;
