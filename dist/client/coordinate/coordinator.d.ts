import { type RegisteredMutation } from "convex/server";
import type { RuntimeContext } from "../registration/context.js";
import type { CoordinateArgs, CoordinateResult } from "../types.js";
/** Build the registered coordinator mutation for one registration. */
export declare function buildCoordinate(rt: RuntimeContext): RegisteredMutation<"internal", CoordinateArgs, CoordinateResult>;
