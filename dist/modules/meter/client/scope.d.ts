/**
 * Attribution-bound charge writers for standalone host calls and core slots.
 * One binding caches attribution lazily while each operation still runs its guard.
 * Trusted slots validate server-derived labels without invoking identity-based
 * host authorization; standalone scope calls retain that authorization step.
 */
import type { MeterContext } from "./configuration.js";
import type { Attribution, ScopedMeter, WriteCtx } from "./types.js";
export type MeterBinding = {
    meter: MeterContext;
    ctx: WriteCtx;
    guard: () => Promise<Attribution>;
};
/**
 * Host calls (`scope`) run the host `authorize` guard. Core's slot calls
 * (`trusted`) do not: their attribution is server-derived, core authorized
 * the turn when it began, and they run in background actions with no user
 * identity, where an identity-based guard would drop every charge.
 */
export declare function bind(meter: MeterContext, ctx: WriteCtx, attributed: () => Promise<Attribution>, trusted: boolean, resolve?: (name: string) => string): ScopedMeter;
/** Bind explicit host attribution; the subject guard remains eager, all other checks lazy. */
export declare function scope(meter: MeterContext, ctx: WriteCtx, attribution: Attribution): ScopedMeter;
