// The optional slot contracts (usage, budget, telemetry, sandbox, extract) and the
// scoped meter.
//
// Optional modules implement these types; core never imports their components.
// `scopedMeter` wraps a usage backend so every charge and charge operation gets a
// deterministic opaque key per call, which makes metering idempotent under
// replay. How each slot is invoked during a turn lives in `turn/slots.ts`.
import { opaqueKey } from "./keys.js";
const noCharge = {
    key: "noop",
    attach: async () => { },
    correct: async () => { },
    settle: async () => { },
    get: async () => null,
};
export const noopMeter = {
    estimate: async () => noCharge,
    record: async () => noCharge,
};
/**
 * The meter a hook or tool call sees. Without a backend it is the no-op meter.
 *
 * Every charge key is derived from `callKey` plus an explicit key or a local
 * ordinal, and every charge operation key from the charge key plus the method,
 * so a replayed call reproduces exactly the same keys and the backend dedupes.
 */
export function scopedMeter(backend, callKey) {
    if (!backend)
        return noopMeter;
    // Counters are local to one deterministic invocation. Method suffixes prevent
    // attach/correct/settle from colliding in the meter's shared operation ledger.
    let ordinal = 0;
    const wrap = (charge) => {
        const counts = { attach: 0, correct: 0, settle: 0 };
        return {
            key: charge.key,
            get: () => charge.get(),
            attach: async (args) => charge.attach({
                ...args,
                key: await opaqueKey("operation", charge.key, "attach", args.key ?? counts.attach++),
            }),
            correct: async (args) => charge.correct({
                ...args,
                key: await opaqueKey("operation", charge.key, "correct", args.key ?? counts.correct++),
            }),
            settle: async (args) => charge.settle({
                ...args,
                key: await opaqueKey("operation", charge.key, "settle", args.key ?? counts.settle++),
            }),
        };
    };
    return {
        estimate: async (provider, args) => wrap(await backend.estimate(provider, {
            ...args,
            key: await opaqueKey("charge", callKey, args.key ?? ordinal++),
        })),
        record: async (provider, args) => wrap(await backend.record(provider, {
            ...args,
            key: await opaqueKey("charge", callKey, args.key ?? ordinal++),
        })),
    };
}
