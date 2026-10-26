/**
 * Shared Daytona adapter context and bounded Python transport.
 * Lifecycle, process and file builders share one SDK client.
 * This host-only bridge never puts credentials in component rows or scheduled args.
 */
import { type Daytona, type DaytonaOptions } from "@daytona/convex";
import { type SandboxContext } from "./types.js";
export type DaytonaContext = {
    client: Daytona;
    opts: DaytonaOptions & {
        snapshot?: string;
        target?: string;
    };
    autoStopInterval: number;
    autoArchiveInterval: number;
};
/** Decode a byte-bounded Python response without a second provider read. */
export declare function decodeBase64(value: string): Uint8Array<ArrayBuffer>;
/** Run one bounded Python operation; provider failures stay visible to the caller. */
export declare function python(runtime: DaytonaContext, ctx: SandboxContext, sandboxId: string, source: string, timeoutS?: number): Promise<string>;
/** Bound regular-file text reads at the source, before the component receives bytes. */
export declare function read(runtime: DaytonaContext, ctx: SandboxContext, sandboxId: string, path: string, maxBytes: number, tail: boolean): Promise<Uint8Array<ArrayBuffer>>;
