/**
 * Host-driven retention and explicit sink retry operations.
 * Retention is an admin operation whose caller supplies its authorization.
 * Sink retry checks subject ownership before resetting the bounded outbox;
 * neither operation starts paid provider work.
 */
import { type MeterContext } from "./configuration.js";
import type { WriteCtx } from "./types.js";
/** Compose maintenance calls without changing their existing authorization boundary. */
export declare function maintenance(meter: MeterContext): {
    /**
     * Retention for host crons. A host admin operation like extract's
     * `purge`: it performs no `authorize`; expose it only behind an admin check.
     * Deletes up to `limit` (default 100, max 500) settled charges whose sinks
     * all acknowledged, created before `before`, and their aggregate entries.
     * It also stops at its transaction budget; call again while `more`. Choose
     * `before` past any replay window: a pruned key recorded again is new.
     */
    prune: (ctx: WriteCtx, args: {
        before: number;
        limit?: number;
    }) => Promise<{
        deleted: number;
        more: boolean;
    }>;
    retrySinks: (ctx: WriteCtx, args: {
        key: string;
        subject: string;
    }) => Promise<null>;
};
