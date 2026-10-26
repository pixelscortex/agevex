// Public types of the managed runtime.
//
// Hooks, registration, authorization and execution scopes, lifecycle events,
// coordinator arguments/results and the minimal `ManagedAgent` capability the
// runtime executes. Re-exported from `index.ts`; every runtime module imports its
// contracts from here. Validator-derived types come from the component schema.

import type { ThreadTextOptions, TextTaskArgs } from "./text/options.js";
import type { UsageSlot, BudgetSlot, TelemetrySlot, SandboxSlot, ExtractSlot } from "./slots.js";
import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  FunctionReference,
} from "convex/server";
import type { Infer } from "convex/values";
import type { AgentComponent, MessageDoc } from "@convex-dev/agent";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { RunSettings } from "../component/run-settings.js";
import type { LanguageModel, ToolSet } from "ai";
import type { ToolContext } from "./once.js";
import type { activity, receipt, runErrorCode } from "../component/schema.js";

export type HookContext = Omit<ToolContext, "toolCallId">;
export type HookResult = void | {
  note?: string;
  block?: string;
  input?: unknown;
  output?: unknown;
  continue?: string;
  model?: string;
};
export type AgentHooks = {
  beforeTurn?: (
    hc: HookContext,
    event: { prompt: string; isRunStart: boolean },
  ) => HookResult | Promise<HookResult>;
  afterTurn?: (
    hc: HookContext,
    event: { turn: number; text: string },
  ) => HookResult | Promise<HookResult>;
  beforeTool?: (
    hc: HookContext,
    event: { tool: string; input: unknown },
  ) => HookResult | Promise<HookResult>;
  afterTool?: (
    hc: HookContext,
    event: { tool: string; input: unknown; output: unknown },
  ) => HookResult | Promise<HookResult>;
  beforeDelegate?: (
    hc: HookContext,
    event: { agent: string; task: string },
  ) => HookResult | Promise<HookResult>;
};
export type SideAgent = {
  agent: ManagedAgent;
  every: { turns: number; minutes?: never } | { minutes: number; turns?: never };
  sees: "delta";
};

export type Receipt = Infer<typeof receipt>;
export type Activity = Infer<typeof activity>;
/** Sanitized failure code of a managed child run or its delivery attempt. */
export type RunErrorCode = Infer<typeof runErrorCode>;

/**
 * Origin of a managed turn. A `subagent_result` turn was started by a delivered
 * child result, so it is a real generation but not a user-triggered prompt: it
 * may acquire the managed delegation tool while the originating run has budget.
 */
export type TurnOrigin = "user" | "subagent_result";

/**
 * Authorization request handed to the host policy for every public read, write,
 * launch and delivery.
 *
 * `open` and `send` include the request key. Authorization runs on every
 * retry and maps the caller's identity to the host's own subject. Fresh paid
 * work can be refused separately through Registration.admit after replay and
 * conflict resolution; authorization never receives replay metadata.
 *
 * Public operations identify the thread being accessed: `messages` supplies
 * that thread's own agent name and id for both roots and children. `open`,
 * `send` and `activity` remain root-only. Background delegation and result
 * delivery identify the root thread and act with no end user on the connection;
 * they carry only server-derived values read back out of persisted state,
 * never anything the client or the model chose.
 *
 * `ctx.auth` may be null for the background variants. A host policy must branch
 * on that explicitly and recheck the capability-validated stored principal
 * against current policy; echoing the supplied `subject` back is not
 * authorization.
 */
export type AuthorizationScope =
  | { operation: "open"; agent: string; requestKey: string }
  | { operation: "send"; agent: string; threadId: string; requestKey: string }
  | { operation: "sandbox"; agent: string; threadId: string; subject: string; runId: string }
  | {
      operation:
        | "pendingApprovals"
        | "title"
        | "rename"
        | "summary"
        | "summarize"
        | "note"
        | "respond"
        | "answer"
        | "cancel"
        | "messages"
        | "streams"
        | "activity";
      agent: string;
      threadId: string;
    }
  | {
      operation: "delegate";
      agent: string;
      threadId: string;
      subject: string;
      rootAssignmentId: string;
      rootAgent: string;
      actorAgent: string;
      childAgent: string;
      task: string;
    }
  | {
      operation: "deliver";
      agent: string;
      threadId: string;
      subject: string;
      rootAssignmentId: string;
      rootAgent: string;
      actorAgent: string;
      childAgent: string;
      runId: string;
    };

/**
 * Trusted execution scope rechecked immediately before every managed model
 * generation, including a child turn and a result-triggered continuation.
 *
 * `child` is present exactly when the turn belongs to a delegated run, and every
 * field in it is read back from persisted state.
 */
export type ExecutionScope = {
  /** Background text uses the same persisted-principal policy without a user connection. */
  purpose?: "title" | "summary";
  subject: string;
  agent: string;
  assignmentId: string;
  threadId: string;
  turnOrigin: TurnOrigin;
  child?: {
    rootAssignmentId: string;
    rootThreadId: string;
    rootAgent: string;
    runId: string;
    actorAgent: string;
    childAgent: string;
  };
};

/**
 * Metadata-only lifecycle event for host analytics and tracing.
 *
 * Events deliberately contain no prompt, result, tool input, or capability.
 * Hosts can attach their own execution identity and schedule persistence from
 * the callback without making observability part of the managed state machine.
 */
export type AgentEvent =
  | {
      type: "request.accepted";
      operation: "open" | "send";
      assignmentId: string;
      threadId: string;
      agent: string;
    }
  | {
      type: "turn.claimed";
      assignmentId: string;
      threadId: string;
      agent: string;
      turnOrigin: TurnOrigin;
    }
  | {
      type: "turn.finished";
      assignmentId: string;
      threadId: string;
      agent: string;
      outcome: "success" | "failure";
      errorCode: Activity["errorCode"];
    }
  | {
      type: "delegation.queued";
      runId: string;
      rootAssignmentId: string;
      agent: string;
    }
  | {
      type: "delegation.settled";
      runId: string;
      rootAssignmentId: string;
      agent: string;
      outcome: "completed" | "failed";
    }
  | {
      type: "delegation.delivered";
      runId: string;
      rootAssignmentId: string;
      agent: string;
      outcome: "accepted" | "failed" | "blocked";
    };

export type ObserveAgentEvent = (
  ctx: GenericActionCtx<GenericDataModel> | GenericMutationCtx<GenericDataModel>,
  event: AgentEvent,
) => Promise<void> | void;
export type TurnArgs = { assignmentId: string; turnToken: string; sliceId?: string };
/** Result of a managed `agevex_delegate` call. A denial is a tool result, not a failure. */
export type DelegationResult =
  | { status: "queued"; runId: string; agent: string }
  | { status: "denied"; code: DelegationDenialCode };
export type DelegationDenialCode =
  | "HOOK_BLOCKED"
  | "ACTIVE_LIMIT"
  | "TASK_LIMIT"
  | "FORBIDDEN"
  | "STALE_TURN"
  | "DELEGATION_CONFLICT"
  | "RUN_BUDGET"
  | "DEPTH_LIMIT"
  | "GROUP_LIMIT"
  | "GROUP_CLOSED"
  | "GROUP_CONFLICT"
  | "CHILD_FINISHED"
  | "MESSAGE_LIMIT"
  | "MESSAGE_TOO_LARGE"
  | "MESSAGE_RATE_LIMIT"
  | "KEY_CONFLICT"
  | "NO_PARENT"
  | "ASK_PENDING"
  | "ASK_WITH_CHILDREN"
  | "QUEUE_LIMIT";

/**
 * The single host-internal coordinator mutation.
 *
 * Every operation is authenticated by a capability the caller already
 * holds: `launch` by the actor's currently running turn token plus the native
 * tool call id, `settle` by the child turn token that owns the run, and `notify`
 * by the one-shot delivery capability minted when the run was launched. There is
 * no separate `runChildTurn` entry point or extra authorization callback.
 * `message`, `ask` and `message_parent` use the actor's current token and the
 * existing background delegate/deliver policy. Progress also carries the
 * native tool call identity for atomic receipt replay.
 */
export type CoordinateArgs =
  | {
      op: "launch";
      side?: boolean;
      assignmentId: string;
      turnToken: string;
      toolCallId: string;
      agent: string;
      task: string;
      group?: string;
      wait?: "each" | "all";
    }
  | { op: "message"; assignmentId: string; turnToken: string; runId: string; text: string }
  | { op: "ask"; assignmentId: string; turnToken: string; question: string }
  | {
      op: "message_parent";
      assignmentId: string;
      turnToken: string;
      toolCallId: string;
      text: string;
    }
  | {
      op: "settle";
      assignmentId: string;
      turnToken: string;
      runId: string;
      resultMessageId?: string;
      errorCode: RunErrorCode;
    }
  | { op: "notify"; runId: string; deliveryToken: string };

/**
 * Launch returns a receipt or denial; message/ask return acceptance or denial.
 * message_parent returns the accepted native message id or a denial.
 * Settlement returns deferred when an admitted follow-up owns the next turn,
 * otherwise null; notify returns null. These are control outcomes only.
 */
export type CoordinateResult =
  | DelegationResult
  | { status: "accepted" | "deferred"; runId: string }
  | { status: "accepted"; messageId: string }
  | null;

// Minimal execution capability, not Agent<object, ToolSet>: native tool sets
// are invariant (notably stop conditions). No native result is widened publicly.
export type ManagedAgent = {
  name: string;
  textModel?: Extract<LanguageModel, string | LanguageModelV4>;
  askUser?: boolean;
  run?: RunSettings;
  sandbox?: boolean;
  hooks?: AgentHooks;
  sideAgents?: readonly SideAgent[];
  subagents: readonly ManagedAgent[];
  component: AgentComponent;
  /**
   * Native tools declared on this agent, captured at construction.
   *
   * A dedicated field rather than the native `options`: comparing the native
   * `Config` intersection against a narrowed shape here exhausts TypeScript's
   * representable union budget, while `ToolSet` against `ToolSet` is free.
   */
  declaredTools: ToolSet;
  _agevexContext: (ctx: object) => void;
  streamText(
    ctx: GenericActionCtx<GenericDataModel>,
    target: { threadId: string },
    args: ManagedGenerationArgs,
    options: {
      saveStreamDeltas: { chunking: "word"; throttleMs: number };
      storageOptions: { saveMessages: "promptAndOutput" };
    },
  ): Promise<{
    consumeStream(options?: { onError: (error: unknown) => void }): PromiseLike<void>;
    finishReason: PromiseLike<string>;
    savedMessages?: MessageDoc[];
  }>;
  generateText(
    ctx: GenericActionCtx<GenericDataModel>,
    target: { threadId: string },
    args: ManagedGenerationArgs,
    options: {
      storageOptions: { saveMessages: "promptAndOutput" };
    },
  ): Promise<{ finishReason: string; savedMessages?: MessageDoc[] }>;
};

/** Per-call native overrides; each managed action pays for one model step. */
export type ManagedGenerationArgs = {
  promptMessageId: string;
  model?: Extract<LanguageModel, string | LanguageModelV4>;
  tools?: ToolSet;
  maxOutputTokens: number;
  maxRetries: number;
  stopWhen: () => boolean;
  abortSignal: AbortSignal;
  toolCallConcurrency: number;
  prepareStep: (options: { model: LanguageModel }) => { model: LanguageModelV4 };
  experimental_download?: import("ai").Experimental_DownloadFunction;
  telemetry?: { integrations: import("ai").Telemetry[] };
};

import type { Limits } from "../component/limits.js";

export type Registration = ThreadTextOptions & {
  /** Absent: ignore usage, allow budgets, export nothing, omit sandbox tools,
   * and pass attachments as native Agent file parts. */
  usage?: UsageSlot;
  budget?: BudgetSlot;
  telemetry?: TelemetrySlot;
  sandbox?: SandboxSlot;
  extract?: ExtractSlot;
  /** Host-owned model ids accepted in open/send. Both options must be supplied together. */
  modelAllowlist?: readonly string[];
  /** Resolver is called only in actions, after validating the stored id against the allowlist. */
  models?: (id: string) => Extract<LanguageModel, string | LanguageModelV4>;
  /**
   * Positive host bounds merged over LIMITS and validated at registration.
   * rootLane/childLane default to 2/4 (max 4/4, eight total slots); every
   * registration on one mount must agree. Sleeping workflows use no slot.
   * slicesPerTurn supplies the default Agent.run.stepsPerTurn and an explicit
   * override also caps the Workflow turn. Per-agent policy creates no pools.
   */
  limits?: Partial<Limits>;
  /**
   * The agents exposed as delegation **roots**. A child is resolved through a
   * root's `subagents`, not listed here, and a name-only entry is not an
   * executable agent.
   */
  agents: readonly ManagedAgent[];
  refs: {
    textTask?: () => FunctionReference<"action", "internal", TextTaskArgs, null>;
    runTurn: () => FunctionReference<"action", "internal", TurnArgs, null>;
    /**
     * Required only when collaboration is configured. Supplied so the managed
     * tool can launch, the host runner can settle, and the watchdog can make one
     * bounded scheduled notification attempt.
     */
    coordinate?: () => FunctionReference<"mutation", "internal", CoordinateArgs, CoordinateResult>;
  };
  /** Runs on every call; the host maps its identity to its own subject. */
  authorize: (
    ctx: GenericQueryCtx<GenericDataModel> | GenericMutationCtx<GenericDataModel>,
    scope: AuthorizationScope,
  ) => Promise<{ subject: string }>;
  /**
   * Refuse new paid work (e.g. exhausted balance) without breaking idempotent
   * retries. Runs only for fresh open/send requests, after authorization,
   * subject-private duplicate/conflict resolution and all returning agevex
   * rejection checks (including queue and attachment limits), before native
   * saves, inbox rows or receipts. No reservation/settlement protocol is needed.
   *
   * Receives the full host MutationCtx. admit may write host state in the same
   * transaction; those writes commit only if the request is accepted. A throw
   * from admit or any later failure rolls back the entire mutation. After this
   * hook, a non-accepting result throws rather than returning a receipt.
   */
  admit?: (
    ctx: GenericMutationCtx<GenericDataModel>,
    input: {
      subject: string;
      operation: "open" | "send";
      agent: string;
      threadId?: string;
      requestKey: string;
    },
  ) => Promise<void>;
  authorizeExecution: (
    ctx: GenericActionCtx<GenericDataModel>,
    scope: ExecutionScope,
  ) => Promise<void>;
  /**
   * Optional metadata-only lifecycle hook for host tracing and analytics.
   *
   * The callback is best effort: a callback failure is swallowed and never
   * changes acceptance, generation, delivery, or settlement. Hosts should
   * enqueue persistence from this callback rather than perform external I/O.
   */
  observe?: ObserveAgentEvent;
};
