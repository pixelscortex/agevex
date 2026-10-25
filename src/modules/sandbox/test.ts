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
