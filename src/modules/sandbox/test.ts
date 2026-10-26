/**
 * convex-test registration for the optional sandbox component.
 * Offline host fixtures mount its schema and functions through register().
 * Native Agent remains a separate fixture dependency when exercising binary exports.
 */
/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import { componentsGeneric, type GenericSchema, type SchemaDefinition } from "convex/server";
import type { ComponentApi } from "./component/_generated/component.js";
import schema from "./component/schema.js";

export const modules = import.meta.glob("./component/**/*.ts");
/** Register only the sandbox component; mount the native Agent separately for exports. */
export function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(
  t: TestConvex<Schema>,
  name = "sandbox",
) {
  t.registerComponent(name, schema, modules);

  return componentsGeneric()[name] as unknown as ComponentApi;
}
export default { register, schema, modules };

// The offline fake provider lives with the sandbox's test entry as well, so
// hosts testing only this module import everything from `agevex/sandbox/test`.
export { fakeSandboxProvider } from "../../testing/sandbox.js";
