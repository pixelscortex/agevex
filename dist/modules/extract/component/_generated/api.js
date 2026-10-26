/* Offline codegen equivalent, matching the core component's checked-in bridge. */
import { anyApi, componentsGeneric } from "convex/server";
const fullApi = anyApi;
export const api = fullApi;
export const internal = fullApi;
export const components = componentsGeneric();
