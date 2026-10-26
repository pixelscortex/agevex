import { type MutationCtx } from "./_generated/server.js";
/** Admit a sandbox identity with the original transactional fence and write order. */
export declare function reserveSandbox(ctx: MutationCtx, args: {
    scopeKey: string;
    provider: string;
    ttl: number;
    existingOnly?: boolean;
}): Promise<{
    status: "claimed";
    claim: `${string}-${string}-${string}-${string}-${string}`;
    sandboxId?: undefined;
} | {
    status: "running" | "unknown";
    claim?: undefined;
    sandboxId?: undefined;
} | {
    status: "existing";
    sandboxId: string;
    claim: string;
}>;
/** Admit one background launch with the original transactional fence and write order. */
export declare function reserveBackgroundJob(ctx: MutationCtx, args: {
    scopeKey: string;
    subject: string;
    threadId: string;
    runId: string;
    pollHandle: string;
    pollMinMs: number;
    pollMaxMs: number;
    jobTimeoutMs: number;
    maximum: number;
}): Promise<{
    jobId: import("convex/values").GenericId<"jobs">;
    claim: `${string}-${string}-${string}-${string}-${string}`;
    providerJobId: `${string}-${string}-${string}-${string}-${string}`;
    sandboxId: string;
    directory: string;
}>;
