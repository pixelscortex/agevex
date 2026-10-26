import type { QueryBuilder, MutationBuilder, GenericMutationCtx } from "convex/server";
import type { DataModel } from "./dataModel.js";
export declare const query: QueryBuilder<DataModel, "public">;
export declare const mutation: MutationBuilder<DataModel, "public">;
export declare const internalMutation: MutationBuilder<DataModel, "internal">;
export type MutationCtx = GenericMutationCtx<DataModel>;
