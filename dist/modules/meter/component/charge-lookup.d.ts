import type { MutationCtx } from "./_generated/server.js";
import type { AttachArgs, ExpireArgs, LookupResultArgs } from "./charge-contracts.js";
import { type Outcome } from "./charge-records.js";
/** Attach one immutable provider request, then admit lookup and its independent deadline. */
export declare function attachCharge(ctx: MutationCtx, args: AttachArgs): Promise<Outcome>;
/** Mark unresolved evidence unknown at its recorded one-shot deadline. */
export declare function expireCharge(ctx: MutationCtx, { id }: ExpireArgs): Promise<void>;
/** Retain late evidence but fence duplicate empty callbacks before scheduling another lookup. */
export declare function recordLookupResult(ctx: MutationCtx, args: LookupResultArgs): Promise<null>;
