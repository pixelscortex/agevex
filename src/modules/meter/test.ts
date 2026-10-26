/**
 * Offline registration for the optional meter component and nested children.
 * Meter tests and host fixtures call register before using component functions.
 * The module glob supplies transaction handlers as well as stable registrations;
 * aggregate and Workpool children share the same convex-test transaction store.
 */
/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import { componentsGeneric, type GenericSchema, type SchemaDefinition } from "convex/server";
import aggregate from "@convex-dev/aggregate/test";
import workpool from "@convex-dev/workpool/test";
import type { ComponentApi } from "./component/_generated/component.js";
import schema from "./component/schema.js";
const modules = import.meta.glob("./component/**/*.ts");

/** Register meter and its aggregate/Workpool children in one deterministic test store. */
export function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(
  t: TestConvex<Schema>,
  name = "meter",
) {
  t.registerComponent(name, schema, modules);

  aggregate.register(
    t as unknown as TestConvex<SchemaDefinition<GenericSchema, boolean>>,
    `${name}/costByThread`,
  );

  aggregate.register(
    t as unknown as TestConvex<SchemaDefinition<GenericSchema, boolean>>,
    `${name}/costBySubject`,
  );

  workpool.register(t, `${name}/workpool`);

  return componentsGeneric()[name] as unknown as ComponentApi;
}
export default { register, schema, modules };
