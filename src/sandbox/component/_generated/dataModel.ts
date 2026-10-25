/** Offline generated bridge; regenerate normally when a deployment is available. */
import type { DataModelFromSchemaDefinition, DocumentByName } from "convex/server";
import type { GenericId } from "convex/values";
import type schema from "../schema.js";
export type DataModel = DataModelFromSchemaDefinition<typeof schema>;
export type Doc<T extends keyof DataModel> = DocumentByName<DataModel, T>;
export type Id<T extends keyof DataModel | "_scheduled_functions"> = GenericId<T>;
