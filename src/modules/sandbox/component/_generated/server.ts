/** Offline generated bridge; public component functions are host-only references. */
import { mutationGeneric, queryGeneric } from "convex/server";
import type { MutationBuilder, QueryBuilder, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { DataModel } from "./dataModel.js";
export const mutation: MutationBuilder<DataModel, "public"> = mutationGeneric;
export const query: QueryBuilder<DataModel, "public"> = queryGeneric;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type QueryCtx = GenericQueryCtx<DataModel>;
