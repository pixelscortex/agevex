/**
 * Pure bounds and validation shared by host and component sandbox code.
 * Registration checks overrides against hard maxima before admitting provider work.
 * Row, output and action budgets keep transactions and provider responses bounded.
 */
/** All host-tunable bounds have hard ceilings; no provider input can lift them. */
export declare const LIMITS: {
    readonly commandTimeoutS: 180;
    readonly outputChars: 6000;
    readonly completionLogChars: 3000;
    readonly completionExitCodeMax: number;
    readonly fileReadChars: 160000;
    readonly writeChars: 160000;
    readonly listEntries: 100;
    readonly exportBytes: number;
    readonly exportBytesNode: number;
    readonly exportChunkBytes: number;
    readonly writeStaleMs: number;
    readonly writeReclaimScan: 4096;
    readonly writeReclaimBatch: 16;
    readonly backgroundExecTimeoutS: 10;
    readonly backgroundKillGraceS: 0.1;
    readonly backgroundControlWaitS: 1;
    readonly backgroundEnvironmentBytes: number;
    readonly backgroundPublishPollS: 0.01;
    readonly backgroundKillBudgetMs: 10000;
    readonly backgroundLeaseMarginMs: 5000;
    readonly execKillMarginS: 5;
    readonly markerKillPasses: 3;
    readonly markerKillPassPauseS: 0.05;
    readonly lateAttemptsMax: 2;
    readonly deleteMinBudgetMs: 30000;
    readonly backgroundRoot: "/tmp/agevex/jobs";
    readonly exportRoot: "/tmp/agevex/exports";
    readonly ttl: number;
    readonly pollMinMs: 1000;
    readonly pollMaxMs: 30000;
    readonly jobTimeoutMs: number;
    readonly jobsPerSandbox: 16;
    readonly cleanupBatch: 32;
    readonly actionBudgetMs: 540000;
    readonly identityChars: 256;
    readonly credentialChars: 4096;
    readonly pathChars: 4096;
    readonly commandChars: 16000;
    readonly providerChars: 64;
    readonly scopeKeyChars: 64;
    readonly claimChars: 64;
    readonly handleChars: 1024;
    readonly utf8BytesPerChar: 4;
    readonly backoffFactor: 2;
    readonly millisecondsPerSecond: 1000;
    readonly daytonaAutoStopMinutes: 15;
    readonly daytonaAutoArchiveMinutes: 10;
    readonly daytonaTimerMaxMinutes: 525600;
    readonly daytonaReadyMs: 300000;
    readonly daytonaRequestMs: 30000;
    readonly disabledAutoDelete: -1;
    readonly sandboxRowBytes: number;
    readonly jobRowBytes: number;
};
export type SandboxLimits = Pick<typeof LIMITS, "commandTimeoutS" | "outputChars" | "fileReadChars" | "writeChars" | "listEntries" | "exportBytes" | "exportBytesNode" | "ttl" | "pollMinMs" | "pollMaxMs" | "jobTimeoutMs" | "jobsPerSandbox" | "cleanupBatch"> extends infer T ? {
    [K in keyof T]: number;
} : never;
export declare const HARD_LIMITS: SandboxLimits;
/** Reject fractional, infinite, negative, zero and excessive host overrides. */
export declare function integer(value: number, maximum: number, name: string, minimum?: number): number;
/** Bound strings before they can become component fields or provider inputs. */
export declare function bounded(value: string, maximum: number, name: string): string;
/** Validate at registration, before any potentially paid work is admitted. */
export declare function resolveLimits(overrides?: Partial<SandboxLimits>): SandboxLimits;
/** Keep the end of output, where command errors and completion messages live. */
export declare function tail(value: string, chars: number): string;
