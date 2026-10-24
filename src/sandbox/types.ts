import type {
  FunctionReference,
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
} from "convex/server";
import type { AgentComponent } from "@convex-dev/agent";
import type { ToolContext } from "../client/once.js";
import type { ComponentApi } from "./component/_generated/component.js";
import type { SandboxLimits } from "./limits.js";

export type SandboxContext = GenericActionCtx<GenericDataModel>;
export type SandboxFacts = Pick<ToolContext, "subject" | "threadId" | "runId">;
export type FileEntry = { name: string; isDir: boolean; size?: number };
export type JobOutcome = {
  state: "running" | "done" | "failed" | "unknown";
  exitCode?: number;
  logTail?: string;
};

/**
 * Providers return an identity before waiting for readiness. resume must be a
 * no-op when ready and preserve the filesystem on stopped/archived/error.
 * Reads/listing must enforce the supplied bound BEFORE returning across a
 * Convex boundary. No method may retry a command or background launch.
 */
export interface SandboxProvider {
  id: string;
  create(ctx: SandboxContext, opts: { scopeKey: string }): Promise<{ sandboxId: string }>;
  resume(ctx: SandboxContext, sandboxId: string): Promise<void>;
  stop(ctx: SandboxContext, sandboxId: string): Promise<void>;
  delete(ctx: SandboxContext, sandboxId: string): Promise<void>;
  exec(
    ctx: SandboxContext,
    sandboxId: string,
    cmd: string,
    opts: { timeoutS: number; signal: AbortSignal },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  startBackground(ctx: SandboxContext, sandboxId: string, cmd: string): Promise<{ jobId: string }>;
  poll(ctx: SandboxContext, jobId: string): Promise<JobOutcome>;
  readFile(
    ctx: SandboxContext,
    sandboxId: string,
    path: string,
    opts: { maxBytes: number },
  ): Promise<string>;
  writeFile(ctx: SandboxContext, sandboxId: string, path: string, content: string): Promise<void>;
  listFiles(
    ctx: SandboxContext,
    sandboxId: string,
    path: string,
    opts: { limit: number },
  ): Promise<FileEntry[]>;
  upload(ctx: SandboxContext, sandboxId: string, path: string, content: Uint8Array): Promise<void>;
  download(
    ctx: SandboxContext,
    sandboxId: string,
    path: string,
    opts: { maxBytes: number },
  ): Promise<Uint8Array>;
}

export type SandboxJobEvent = SandboxFacts & {
  type: "sandbox.job.completed";
  jobId: string;
  providerJobId?: string;
  scopeKey: string;
  state: "done" | "failed" | "unknown";
  exitCode?: number;
  logTail?: string;
};

export type SandboxAuthorization = Partial<SandboxFacts> & {
  operation: "use" | "export" | "stop" | "delete" | "poll" | "cleanup";
  scopeKey?: string;
};

export type SandboxUsageEvent = Partial<SandboxFacts> & {
  provider: string;
  /** Absent for a lost create response; scopeKey still identifies the reservation. */
  sandboxId?: string;
  scopeKey?: string;
  operation: "create" | "resume" | "stop" | "delete" | "exec" | "write" | "background" | "export";
  outcome: "observed" | "unknown";
  source: "estimate";
  at: number;
};

export type PollArgs = { jobId: string };
export type SettleArgs = PollArgs & {
  claim: string;
  state: "done" | "failed" | "unknown";
  exitCode?: number;
  logTail?: string;
};

/** Host references keep provider configuration and secrets out of scheduled args. */
export type SandboxRefs = {
  poll: () => FunctionReference<"action", "internal", PollArgs, null>;
  settle: () => FunctionReference<"mutation", "internal", SettleArgs, null>;
  cleanup: () => FunctionReference<"action", "internal", Record<string, never>, null>;
};

export type SandboxOptions = {
  component: ComponentApi;
  provider: SandboxProvider;
  scope: "thread" | "run" | "subject";
  limits?: Partial<SandboxLimits>;
  /** Recheck current host policy; background calls have no authenticated user. */
  authorize: (
    ctx: SandboxContext | GenericMutationCtx<GenericDataModel>,
    scope: SandboxAuthorization,
  ) => Promise<{ subject: string }>;
  refs?: SandboxRefs;
  agent?: AgentComponent;
  /** Required for run-scoped exports; resolve from host-owned rows, never transcripts. */
  resolveThread?: (ctx: SandboxContext, threadId: string) => Promise<SandboxFacts>;
  /** Runs atomically with the terminal job transition. Throwing rolls both back. */
  onComplete?: (ctx: GenericMutationCtx<GenericDataModel>, event: SandboxJobEvent) => Promise<void>;
  /** Best effort metadata observations. Daytona has no authoritative cost. */
  usage?: { record(ctx: SandboxContext, event: SandboxUsageEvent): Promise<void> };
};
