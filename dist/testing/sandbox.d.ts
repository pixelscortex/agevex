/**
 * Deterministic in-memory sandbox provider for offline behavior tests.
 * Lifecycle, execution queues and bounded filesystem operations share isolated state.
 * Hooks simulate uncertain provider outcomes without shell commands or credentials.
 */
import type { SandboxProvider, JobOutcome } from "../modules/sandbox/client/types.js";
type FakeMachine = {
    state: "creating" | "ready" | "stopped" | "archived" | "error" | "deleted";
    files: Map<string, Uint8Array>;
};
type ExecResult = {
    exitCode: number;
    stdout: string;
    stderr: string;
    timedOut?: boolean;
};
type FakeOptions = {
    exec?: (command: string, sandboxId: string) => Promise<ExecResult> | ExecResult;
    beforeReady?: (sandboxId: string) => Promise<void>;
    create?: () => Promise<void>;
    background?: (command: string) => JobOutcome[];
};
/** In-memory provider: deterministic, no fetch, no shell, no provider credentials. */
export declare function fakeSandboxProvider(opts?: FakeOptions): {
    provider: SandboxProvider;
    sandboxes: Map<string, FakeMachine>;
    jobs: Map<string, JobOutcome[]>;
    calls: {
        create: number;
        resume: number;
        stop: number;
        delete: number;
        exec: string[];
        background: string[];
        poll: string[];
        cancel: string[];
    };
};
export {};
