/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import { componentsGeneric, type GenericSchema, type SchemaDefinition } from "convex/server";
import workpool from "@convex-dev/workpool/test";
import type { ComponentApi } from "./component/_generated/component.js";
import schema from "./component/schema.js";
const modules = import.meta.glob("./component/**/*.ts");

/** Register Agevex and its nested Workpool/batch-worker, not the sibling native Agent. */
export function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(
  t: TestConvex<Schema>,
  name = "agevex",
) {
  t.registerComponent(name, schema, modules);
  workpool.register(t, `${name}/workpool`);
  return componentsGeneric()[name] as unknown as ComponentApi;
}
export default { register, schema, modules };
