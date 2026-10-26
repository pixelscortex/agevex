import { type Infer } from "convex/values";
/** Per-step defaults and hard ceilings; the combined deadline is checked too. */
export declare const RUN_LIMITS: {
    readonly maxOutputTokens: {
        readonly default: 4096;
        readonly min: 1;
        readonly max: 32768;
    };
    readonly modelTimeoutMs: {
        readonly default: 90000;
        readonly min: 1000;
        readonly max: 300000;
    };
    readonly toolTimeoutMs: {
        readonly default: 90000;
        readonly min: 1000;
        readonly max: 300000;
    };
    readonly stepsPerTurn: {
        readonly default: 16;
        readonly min: 1;
        readonly max: 64;
    };
    readonly toolsPerSlice: 16;
    readonly persistenceMs: 30000;
    readonly sliceDeadlineMs: 300000;
    readonly watchdogMarginMs: 30000;
    readonly metadataBytes: number;
    readonly nativeEnvelopeBytes: 256;
    readonly cancelBudgets: number;
    readonly settingsBytes: number;
};
/** Public options on Agent.run; validation happens at registration. */
export type RunSettings = Partial<ResolvedRunSettings>;
/** Policy returned by claim and consumed by generation and its watchdog. */
export declare const runSettings: import("convex/values").VObject<{
    askUser?: boolean | undefined;
    mode: "stream" | "generate";
    maxOutputTokens: number;
    modelTimeoutMs: number;
    toolTimeoutMs: number;
    stepsPerTurn: number;
}, {
    askUser: import("convex/values").VBoolean<boolean | undefined, "optional">;
    mode: import("convex/values").VUnion<"stream" | "generate", [import("convex/values").VLiteral<"stream", "required">, import("convex/values").VLiteral<"generate", "required">], "required", never>;
    maxOutputTokens: import("convex/values").VFloat64<number, "required">;
    modelTimeoutMs: import("convex/values").VFloat64<number, "required">;
    toolTimeoutMs: import("convex/values").VFloat64<number, "required">;
    stepsPerTurn: import("convex/values").VFloat64<number, "required">;
}, "required", "askUser" | "mode" | "maxOutputTokens" | "modelTimeoutMs" | "toolTimeoutMs" | "stepsPerTurn">;
/** Fully resolved policy, independent of subsequent registration changes. */
export type ResolvedRunSettings = Infer<typeof runSettings>;
/** Bounded name-to-policy snapshot stored only on the existing root runs row. */
export declare const settingsSnapshot: import("convex/values").VArray<{
    agent: string;
    settings: {
        askUser?: boolean | undefined;
        mode: "stream" | "generate";
        maxOutputTokens: number;
        modelTimeoutMs: number;
        toolTimeoutMs: number;
        stepsPerTurn: number;
    };
}[], import("convex/values").VObject<{
    agent: string;
    settings: {
        askUser?: boolean | undefined;
        mode: "stream" | "generate";
        maxOutputTokens: number;
        modelTimeoutMs: number;
        toolTimeoutMs: number;
        stepsPerTurn: number;
    };
}, {
    agent: import("convex/values").VString<string, "required">;
    settings: import("convex/values").VObject<{
        askUser?: boolean | undefined;
        mode: "stream" | "generate";
        maxOutputTokens: number;
        modelTimeoutMs: number;
        toolTimeoutMs: number;
        stepsPerTurn: number;
    }, {
        askUser: import("convex/values").VBoolean<boolean | undefined, "optional">;
        mode: import("convex/values").VUnion<"stream" | "generate", [import("convex/values").VLiteral<"stream", "required">, import("convex/values").VLiteral<"generate", "required">], "required", never>;
        maxOutputTokens: import("convex/values").VFloat64<number, "required">;
        modelTimeoutMs: import("convex/values").VFloat64<number, "required">;
        toolTimeoutMs: import("convex/values").VFloat64<number, "required">;
        stepsPerTurn: import("convex/values").VFloat64<number, "required">;
    }, "required", "askUser" | "mode" | "maxOutputTokens" | "modelTimeoutMs" | "toolTimeoutMs" | "stepsPerTurn">;
}, "required", "agent" | "settings" | "settings.askUser" | "settings.mode" | "settings.maxOutputTokens" | "settings.modelTimeoutMs" | "settings.toolTimeoutMs" | "settings.stepsPerTurn">, "required">;
export type SettingsSnapshot = Infer<typeof settingsSnapshot>;
/** Validate before any work is accepted, including the platform action ceiling. */
export declare function resolveRunSettings(input?: RunSettings): ResolvedRunSettings;
/** Bound a slice even when many slow tools are allowed. Phase deadlines still
 * apply independently; the five-minute cap prevents a default 26-minute wait. */
export declare function sliceDeadlineMs(settings: ResolvedRunSettings): number;
/** The server waits beyond the client fence so timeout finalization can commit. */
export declare function sliceWatchdogMs(settings: ResolvedRunSettings): number;
/** Bound both Convex and JSON bytes, including multi-byte names and escaping. */
export declare function assertSettingsSnapshot(settings: SettingsSnapshot): void;
