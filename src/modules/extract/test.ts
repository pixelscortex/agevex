/// <reference types="vite/client" />
// convex-test registration helper, including extraction's Workflow/Workpool children.
import type { TestConvex } from "convex-test";
import { componentsGeneric, type GenericSchema, type SchemaDefinition } from "convex/server";
import workflow from "@convex-dev/workflow/test";
import workpool from "@convex-dev/workpool/test";
import type { ComponentApi } from "./component/_generated/component.js";
import schema from "./component/schema.js";
export const modules = import.meta.glob("./component/**/*.ts");
export function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(
  t: TestConvex<Schema>,
  name = "agevexExtract",
) {
  t.registerComponent(name, schema, modules);
  workflow.register(t, name + "/workflow");
  workpool.register(t, name + "/workflow/workpool");

  return componentsGeneric()[name] as unknown as ComponentApi;
}
export default { register, schema, modules };
