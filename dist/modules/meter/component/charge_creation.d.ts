import type { MutationCtx } from "./_generated/server.js";
import type { CreateArgs } from "./charge_contracts.js";
/** Validate, replay or admit one charge, then update projections and outbox in order. */
export declare function createCharge(ctx: MutationCtx, args: CreateArgs): Promise<null>;
