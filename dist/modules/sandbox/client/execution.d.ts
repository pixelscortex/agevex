import { type SandboxCall } from "./types.js";
import { type RuntimeContext } from "./runtime-context.js";
/** Run an admitted command once with a kill margin and a shared stdout/stderr receipt bound. */
export declare function exec(runtime: RuntimeContext, tc: SandboxCall, input: {
    command: string;
}): Promise<{
    status: "done";
    exitCode: number;
    timedOut: boolean;
    stdout: string;
    stderr: string;
    truncated: boolean;
} | {
    status: "unknown";
    exitCode?: undefined;
    timedOut?: undefined;
    stdout?: undefined;
    stderr?: undefined;
    truncated?: undefined;
}>;
/** Persist job identity and watchdog before launch; uncertainty never launches the command again. */
export declare function background(runtime: RuntimeContext, tc: SandboxCall, input: {
    command: string;
}): Promise<{
    status: "running";
    jobId: string;
} | {
    status: "unknown";
    jobId: string;
}>;
