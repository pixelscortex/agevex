/* Offline codegen equivalent; component public functions are host-only across the mount. */
import { queryGeneric, mutationGeneric, internalMutationGeneric } from "convex/server";
export const query = queryGeneric;
export const mutation = mutationGeneric;
export const internalMutation = internalMutationGeneric;
