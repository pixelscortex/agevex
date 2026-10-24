/* eslint-disable */
/** Offline codegen equivalent; replace with deployment codegen when available. */
import { mutationGeneric, queryGeneric, internalMutationGeneric } from "convex/server";
import type { MutationBuilder, QueryBuilder, GenericMutationCtx, GenericQueryCtx } from "convex/server";
import type { DataModel } from "./dataModel.js";
export const mutation: MutationBuilder<DataModel, "public"> = mutationGeneric;
export const query: QueryBuilder<DataModel, "public"> = queryGeneric;
export const internalMutation: MutationBuilder<DataModel, "internal"> = internalMutationGeneric;
export type MutationCtx = GenericMutationCtx<DataModel>;
export type QueryCtx = GenericQueryCtx<DataModel>;
