import { type MeterContext } from "./configuration.js";
/** Export these two INTERNAL actions from the host module named in workers. */
export declare function internalFunctions(meter: MeterContext): {
    meterLookup: import("convex/server").RegisteredAction<"internal", {
        key: string;
        provider: string;
        jobs: {
            deliver?: string | undefined;
            lookup?: string | undefined;
            maxAttempts: number;
        };
        requestId: string;
        attempt: number;
        until: number;
    }, Promise<null>>;
    meterDeliver: import("convex/server").RegisteredAction<"internal", {
        claim: string;
        jobs: {
            deliver?: string | undefined;
            lookup?: string | undefined;
            maxAttempts: number;
        };
        sink: string;
    }, Promise<null>>;
};
