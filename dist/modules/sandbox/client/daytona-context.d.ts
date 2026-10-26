/**
 * Shared Daytona adapter context and bounded Python transport.
 * Lifecycle, process and file builders share one SDK client.
 * This host-only bridge never puts credentials in component rows or scheduled args.
 */
import { Daytona, type ComponentApi, type DaytonaOptions } from "@daytona/convex";
import { type Credential } from "./credential.js";
import { type SandboxContext } from "./types.js";
/** SDK options where the key may be a getter resolved per call, not at construction. */
export type DaytonaSettings = Omit<DaytonaOptions, "apiKey"> & {
    apiKey?: Credential;
    snapshot?: string;
    target?: string;
};
/** `client` yields an SDK client carrying the key resolved for this call. */
export type DaytonaContext = {
    client: () => Promise<Daytona>;
    apiKey: () => Promise<string>;
    opts: DaytonaSettings;
    autoStopInterval: number;
    autoArchiveInterval: number;
};
/**
 * Build the per-call key resolver and SDK client factory. Nothing reads env or
 * calls a getter here: an unset `apiKey` keeps the SDK's own call-time env
 * fallback, and `apiKey()` (REST recovery) falls back the same way when called.
 */
export declare function bindCredentials(component: ComponentApi, opts: DaytonaSettings): {
    client: () => Promise<Daytona>;
    apiKey: () => Promise<string>;
};
/** Decode a byte-bounded Python response without a second provider read. */
export declare function decodeBase64(value: string): Uint8Array<ArrayBuffer>;
/** Run one bounded Python operation; provider failures stay visible to the caller. */
export declare function python(runtime: DaytonaContext, ctx: SandboxContext, sandboxId: string, source: string, timeoutS?: number): Promise<string>;
/** Bound regular-file text reads at the source, before the component receives bytes. */
export declare function read(runtime: DaytonaContext, ctx: SandboxContext, sandboxId: string, path: string, maxBytes: number, tail: boolean): Promise<Uint8Array<ArrayBuffer>>;
