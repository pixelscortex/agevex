import type {
  GenericActionCtx,
  GenericDataModel,
  GenericMutationCtx,
  GenericQueryCtx,
  FunctionReference,
} from "convex/server";
import type { Infer } from "convex/values";
import type { AgentComponent, MessageDoc } from "@convex-dev/agent";
import type { ToolSet } from "ai";
import type { activity, receipt, runErrorCode } from "../component/schema.js";

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
  | { operation: "open"; agent: string }
  | { operation: "send" | "cancel" | "messages" | "activity"; agent: string; threadId: string }
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
  | "ACTIVE_LIMIT"
  | "TASK_LIMIT"
  | "FORBIDDEN"
  | "STALE_TURN"
  | "DELEGATION_CONFLICT"
  | "RUN_BUDGET";

/**
 * The single host-internal coordinator mutation.
 *
 * Exactly three operations, all authenticated by a capability the caller already
 * holds: `launch` by the actor's currently running turn token plus the native
 * tool call id, `settle` by the child turn token that owns the run, and `notify`
 * by the one-shot delivery capability minted when the run was launched. There is
 * no separate `runChildTurn` entry point and no third authorization callback.
 */
export type CoordinateArgs =
  | {
      op: "launch";
      assignmentId: string;
      turnToken: string;
      toolCallId: string;
      agent: string;
      task: string;
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
 * `launch` returns a receipt or a sanitized denial. `settle` and `notify`
 * return `null`: their outcome is recorded as persisted state, and neither
 * reports generated output, a read or a completed task.
 */
export type CoordinateResult = DelegationResult | null;

// Minimal execution capability, not Agent<object, ToolSet>: native tool sets
// are invariant (notably stop conditions). No native result is widened publicly.
export type ManagedAgent = {
  name: string;
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
    args: {
      promptMessageId: string;
      /** Only present when the managed delegation tool is merged in. */
      tools?: ToolSet;
      maxOutputTokens: number;
      maxRetries: number;
      stopWhen: () => boolean;
      abortSignal: AbortSignal;
    },
    options: {
      saveStreamDeltas: { chunking: "word"; throttleMs: number };
      storageOptions: { saveMessages: "promptAndOutput" };
    },
  ): Promise<{
    consumeStream(options?: { onError: (error: unknown) => void }): PromiseLike<void>;
    finishReason: PromiseLike<string>;
    /** Native saves that completed before the stream resolved. */
    savedMessages?: MessageDoc[];
  }>;
};

export type Registration = {
  /**
   * The agents exposed as delegation **roots**. A child is resolved through a
   * root's `subagents`, not listed here, and a name-only entry is not an
   * executable agent.
   */
  agents: readonly ManagedAgent[];
  refs: {
    runTurn: () => FunctionReference<"action", "internal", TurnArgs, null>;
    /**
     * Required only when collaboration is configured. Supplied so the managed
     * tool can launch, the host runner can settle, and the watchdog can make one
     * bounded scheduled notification attempt.
     */
    coordinate?: () => FunctionReference<"mutation", "internal", CoordinateArgs, CoordinateResult>;
  };
  authorize: (
    ctx: GenericQueryCtx<GenericDataModel> | GenericMutationCtx<GenericDataModel>,
    scope: AuthorizationScope,
  ) => Promise<{ subject: string }>;
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
