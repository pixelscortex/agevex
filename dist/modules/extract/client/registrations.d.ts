import { type RuntimeContext } from "./context.js";
/** Register the internal worker and exact storage-size query without admitting paid work. */
export declare function internalFunctions(runtime: RuntimeContext): {
    storageMetadata: import("convex/server").RegisteredQuery<"internal", {
        storageId: string;
    }, Promise<{
        size: number;
    } | null>>;
    execute: import("convex/server").RegisteredAction<"internal", {
        subject?: string | undefined;
        threadId: string;
        claim: string;
        attempt: number;
        artifactId: string;
    }, Promise<null>>;
};
