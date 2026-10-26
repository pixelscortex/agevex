/**
 * Host contracts for sandbox providers, authorization and completion callbacks.
 * The public factory and concrete adapters use these types on the host side.
 * Provider methods enforce source-side bounds and never retry uncertain paid effects.
 */
import {
  type FunctionReference,
  type GenericActionCtx,
  type GenericDataModel,
  type GenericMutationCtx,
} from "convex/server";
import { type AgentComponent } from "@convex-dev/agent";
import { type ToolContext } from "../../../client/once.js";
import { type ComponentApi } from "../component/_generated/component.js";
import { type SandboxLimits } from "../shared/limits.js";

export type SandboxContext = GenericActionCtx<GenericDataModel>;
export type SandboxFacts = Pick<ToolContext, "subject" | "threadId" | "runId">;
/**
 * The part of core's ToolContext this module reads. A full ToolContext (which
 * also carries rootThreadId, agent and meter) satisfies it, so host code that
 * already holds one passes it unchanged, while the module's own export path can
 * build a call without fabricating facts it never uses.
 */
export type SandboxCall = SandboxFacts & Pick<ToolContext, "ctx" | "signal" | "toolCallId">;
export type FileEntry = { name: string; isDir: boolean; size?: number };
export type BackgroundLocation = { sandboxId: string; directory: string };
export type BackgroundJob = BackgroundLocation & { jobId: string };
export type JobOutcome = {
  state: "running" | "done" | "failed" | "unknown";
  exitCode?: number;
  logTail?: string;
  code?: "SANDBOX_JOB_DEADLINE";
};

/**
 * Providers return an identity before waiting for readiness. resume must be a
 * no-op when ready and preserve the filesystem on stopped/archived/error.
 * Reads/listing must enforce the supplied bound BEFORE returning across a
 * Convex boundary. No method may retry a command or background launch.
 * A supplied background identity/location was persisted before launch and
 * must be honored, including when launch throws. cancelBackground performs
 * bounded cleanup of the job's original process group, verifying ownership
 * before any fallback signal; an unverified outcome remains unknown.
 * On command exit, descendants still in that group must be terminated before
 * publishing completion. Deliberate detachment (setsid / daemonizing) requires
 * sandbox stop/delete for full containment; isolation comes from the provider.
 * download returns a bounded window starting at offset (a short window means
 * EOF), rejects files above totalSizeLimit, and never records file bytes in
 * component args or rows.
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
  ): Promise<{ exitCode: number; stdout: string; stderr: string; timedOut?: boolean }>;
  startBackground(
    ctx: SandboxContext,
    sandboxId: string,
    cmd: string,
    job?: BackgroundJob,
  ): Promise<BackgroundJob>;
  poll(ctx: SandboxContext, jobId: string, location: BackgroundLocation): Promise<JobOutcome>;
  cancelBackground(ctx: SandboxContext, jobId: string, location: BackgroundLocation): Promise<void>;
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
  /** Append one <=512 KiB window, or accept an exact duplicate at an earlier offset. */
  writeWindow(
    ctx: SandboxContext,
    sandboxId: string,
    tempPath: string,
    offset: number,
    bytes: Uint8Array,
  ): Promise<void>;
  /** Verify size/hash and atomically replace path with the completed sibling staging file. */
  commitWrite(
    ctx: SandboxContext,
    sandboxId: string,
    tempPath: string,
    path: string,
    expected: SandboxWriteResult,
  ): Promise<void>;
  /** Remove an abandoned staging file; an absent file is already discarded. */
  discardWrite(ctx: SandboxContext, sandboxId: string, tempPath: string): Promise<void>;
  /**
   * Remove stages and transport windows in `directory` whose names start with `prefix`
   * and whose last write is older than `olderThanMs`. Fresh files belong to a live attempt.
   */
  reclaimWrites(
    ctx: SandboxContext,
    sandboxId: string,
    directory: string,
    prefix: string,
    olderThanMs: number,
  ): Promise<void>;
  download(
    ctx: SandboxContext,
    sandboxId: string,
    path: string,
    opts: { maxBytes: number; offset?: number; totalSizeLimit?: number },
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
  code?: "SANDBOX_JOB_DEADLINE";
};

export type SandboxAuthorization = Partial<SandboxFacts> & {
  operation: "use" | "export" | "stop" | "delete" | "poll" | "cleanup" | "forget";
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
/** The claim a wake mutation took for the poll action it schedules. */
export type PollActionArgs = PollArgs & { claim: string };
export type SandboxExportArgs = { threadId: string; path: string };
export type SandboxWriteArgs = {
  path: string;
  source: { storageId: import("convex/values").GenericId<"_storage"> } | { bytes: Uint8Array };
  maxBytes?: number;
};
export type SandboxWriteResult = { bytes: number; sha256: string };
/** Node delegation carries only trusted facts and a storage reference, never a large binary argument. */
export type SandboxNodeWriteArgs = SandboxFacts &
  Omit<SandboxWriteArgs, "source"> & {
    source: { storageId: import("convex/values").GenericId<"_storage"> };
  };
export type SandboxWriteBytes = {
  (tc: SandboxCall, input: SandboxWriteArgs): Promise<SandboxWriteResult>;
  (ctx: SandboxContext, input: SandboxWriteArgs & SandboxFacts): Promise<SandboxWriteResult>;
};
export type SandboxExportResult = {
  fileId: string;
  storageId: import("convex/values").GenericId<"_storage">;
  bytes: number;
  sha256: string;
};
export type SettleArgs = PollArgs & {
  claim: string;
  state: "done" | "failed" | "unknown";
  exitCode?: number;
  logTail?: string;
  code?: "SANDBOX_JOB_DEADLINE";
};

/** Host references keep provider configuration and secrets out of scheduled args. */
export type SandboxRefs = {
  /** The scheduled entry point: a mutation, so it runs exactly once. */
  wake: () => FunctionReference<"mutation", "internal", PollArgs, null>;
  poll: () => FunctionReference<"action", "internal", PollActionArgs, null>;
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
  /** Register sandboxNodeExport(options) from a host file beginning with "use node". */
  nodeExport?: FunctionReference<"action", "internal", SandboxExportArgs, SandboxExportResult>;
  /** Register sandboxNodeWrite(options) from a host "use node" file for storage-backed writes above 8 MiB. */
  nodeWrite?: FunctionReference<"action", "internal", SandboxNodeWriteArgs, SandboxWriteResult>;
  /** Required for run-scoped exports; resolve from host-owned rows, never transcripts. */
  resolveThread?: (ctx: SandboxContext, threadId: string) => Promise<SandboxFacts>;
  /** Runs atomically with the terminal job transition. Throwing rolls both back. */
  onComplete?: (ctx: GenericMutationCtx<GenericDataModel>, event: SandboxJobEvent) => Promise<void>;
  /** Best effort metadata observations. Daytona has no authoritative cost. */
  usage?: { record(ctx: SandboxContext, event: SandboxUsageEvent): Promise<void> };
};
