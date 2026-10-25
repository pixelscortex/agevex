// Local host fixture boundary for convex-test; no deployment/codegen needed.
import { anyApi, componentsGeneric } from "convex/server";
export const api = anyApi;
export const internal = anyApi;
export const components = componentsGeneric();
