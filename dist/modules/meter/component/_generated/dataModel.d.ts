/** Offline codegen equivalent, derived from the component schema. */
import type { DataModelFromSchemaDefinition, DocumentByName } from "convex/server";
import type { GenericId } from "convex/values";
import type schema from "../schema.js";
export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export type Doc<T extends keyof DataModel> = DocumentByName<DataModel, T>;
export type Id<T extends keyof DataModel> = GenericId<T>;
