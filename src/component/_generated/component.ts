/* eslint-disable */
/**
 * Generated `ComponentApi` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type { FunctionReference } from "convex/server";

/**
 * A utility for referencing a Convex component's exposed API.
 *
 * Useful when expecting a parameter like `components.myComponent`.
 * Usage:
 * ```ts
 * async function myFunction(ctx: QueryCtx, component: ComponentApi) {
 *   return ctx.runQuery(component.someFile.someQuery, { ...args });
 * }
 * ```
 */
export type ComponentApi<Name extends string | undefined = string | undefined> =
  {
    queue: {
      accept: FunctionReference<
        "mutation",
        "internal",
        {
          agent: string;
          fingerprint: string;
          promptMessageId: string;
          requestKey: string;
          runTurn: string;
          subject: string;
          threadId: string;
        },
        {
          assignmentId: string;
          receiptId: string;
          status: "accepted";
          threadId: string;
        },
        Name
      >;
      activity: FunctionReference<
        "query",
        "internal",
        { subject: string; threadId: string },
        {
          agent: string;
          assignmentId: string;
          assignmentStatus: "open";
          errorCode:
            | null
            | "GENERATION_FAILED"
            | "AUTHORIZATION_DENIED"
            | "EXECUTION_AMBIGUOUS";
          queuedMessages: number;
          subagents: { active: number; history: number; total: number };
          threadId: string;
          turnStatus: "queued" | "running" | "idle" | "recovery_required";
        },
        Name
      >;
      ambiguous: FunctionReference<
        "mutation",
        "internal",
        { assignmentId: string; turnToken: string },
        null,
        Name
      >;
      assignment: FunctionReference<
        "query",
        "internal",
        { threadId: string },
        null | {
          agent: string;
          assignmentId: string;
          subject: string;
          threadId: string;
        },
        Name
      >;
      claim: FunctionReference<
        "mutation",
        "internal",
        { assignmentId: string; turnToken: string },
        null | {
          agent: string;
          assignmentId: string;
          promptMessageId: string;
          subagent: null | {
            actorAgent: string;
            agent: string;
            childThreadId: string;
            deliveryToken: string;
            rootAgent: string;
            rootAssignmentId: string;
            rootThreadId: string;
            runId: string;
            subject: string;
          };
          subject: string;
          threadId: string;
          turnOrigin: "user" | "subagent_result";
        },
        Name
      >;
      finish: FunctionReference<
        "mutation",
        "internal",
        {
          assignmentId: string;
          errorCode:
            | null
            | "GENERATION_FAILED"
            | "AUTHORIZATION_DENIED"
            | "EXECUTION_AMBIGUOUS";
          turnToken: string;
        },
        null,
        Name
      >;
      lookupReceipt: FunctionReference<
        "query",
        "internal",
        { fingerprint: string; requestKey: string; subject: string },
        null | {
          assignmentId: string;
          receiptId: string;
          status: "accepted";
          threadId: string;
        },
        Name
      >;
    };
    subagents: {
      attach: FunctionReference<
        "mutation",
        "internal",
        { childThreadId: string; promptMessageId: string; runId: string },
        null,
        Name
      >;
      delegateContext: FunctionReference<
        "query",
        "internal",
        { assignmentId: string; turnToken: string },
        null | {
          activeRuns: number;
          actorAgent: string;
          rootAgent: string;
          rootAssignmentId: string;
          rootThreadId: string;
          subject: string;
        },
        Name
      >;
      delegations: FunctionReference<
        "query",
        "internal",
        {
          paginationOpts: {
            cursor: string | null;
            endCursor?: string | null;
            id?: number;
            maximumBytesRead?: number;
            maximumRowsRead?: number;
            numItems: number;
          };
          subject: string;
          threadId: string;
        },
        {
          continueCursor: string;
          isDone: boolean;
          page: Array<{
            agent: string;
            createdAt: number;
            deliveryAt: null | number;
            deliveryStatus: "pending" | "accepted" | "failed" | "blocked";
            errorCode:
              | null
              | "GENERATION_FAILED"
              | "EXECUTION_AMBIGUOUS"
              | "EMPTY_RESULT"
              | "RESULT_UNVERIFIED"
              | "AUTHORIZATION_DENIED"
              | "ROOT_UNAVAILABLE"
              | "DELIVERY_FAILED";
            events: Array<{
              agent: string;
              at: number;
              errorCode:
                | null
                | "GENERATION_FAILED"
                | "EXECUTION_AMBIGUOUS"
                | "EMPTY_RESULT"
                | "RESULT_UNVERIFIED"
                | "AUTHORIZATION_DENIED"
                | "ROOT_UNAVAILABLE"
                | "DELIVERY_FAILED";
              phase:
                | "queued"
                | "started"
                | "completed"
                | "failed"
                | "result_accepted"
                | "delivery_failed"
                | "delivery_blocked";
              runId: string;
            }>;
            finishedAt: null | number;
            resultMessageId: null | string;
            runId: string;
            startedAt: null | number;
            status: "queued" | "running" | "completed" | "failed";
          }>;
          pageStatus?: "SplitRecommended" | "SplitRequired" | null;
          splitCursor?: string | null;
        },
        Name
      >;
      deliver: FunctionReference<
        "mutation",
        "internal",
        {
          deliveryStatus: "accepted" | "failed" | "blocked";
          deliveryToken: string;
          errorCode:
            | null
            | "GENERATION_FAILED"
            | "EXECUTION_AMBIGUOUS"
            | "EMPTY_RESULT"
            | "RESULT_UNVERIFIED"
            | "AUTHORIZATION_DENIED"
            | "ROOT_UNAVAILABLE"
            | "DELIVERY_FAILED";
          parentMessageId: string | null;
          runId: string;
        },
        null,
        Name
      >;
      deliveryContext: FunctionReference<
        "query",
        "internal",
        { deliveryToken: string; runId: string },
        null | {
          actorAgent: string;
          agent: string;
          childResultMessageId: string | null;
          childThreadId: string;
          errorCode:
            | null
            | "GENERATION_FAILED"
            | "EXECUTION_AMBIGUOUS"
            | "EMPTY_RESULT"
            | "RESULT_UNVERIFIED"
            | "AUTHORIZATION_DENIED"
            | "ROOT_UNAVAILABLE"
            | "DELIVERY_FAILED";
          rootAgent: string;
          rootAssignmentId: string;
          rootAvailable: boolean;
          rootThreadId: string;
          runId: string;
          status: "completed" | "failed";
          subject: string;
        },
        Name
      >;
      reserve: FunctionReference<
        "mutation",
        "internal",
        {
          agent: string;
          assignmentId: string;
          coordinateHandle: string;
          payloadFingerprint: string;
          runTurn: string;
          toolCallId: string;
          turnToken: string;
        },
        | { kind: "reserved"; runId: string }
        | { agent: string; kind: "replay"; runId: string }
        | {
            code:
              | "ACTIVE_LIMIT"
              | "TASK_LIMIT"
              | "FORBIDDEN"
              | "STALE_TURN"
              | "DELEGATION_CONFLICT";
            kind: "denied";
          },
        Name
      >;
      settle: FunctionReference<
        "mutation",
        "internal",
        {
          assignmentId: string;
          childResultMessageId: string | null;
          errorCode:
            | null
            | "GENERATION_FAILED"
            | "EXECUTION_AMBIGUOUS"
            | "EMPTY_RESULT"
            | "RESULT_UNVERIFIED"
            | "AUTHORIZATION_DENIED"
            | "ROOT_UNAVAILABLE"
            | "DELIVERY_FAILED";
          runId: string;
          turnToken: string;
        },
        null,
        Name
      >;
      settlementContext: FunctionReference<
        "query",
        "internal",
        { assignmentId: string; runId: string; turnToken: string },
        null | {
          agent: string;
          childResultMessageId: string | null;
          childThreadId: string;
          runId: string;
          subject: string;
        },
        Name
      >;
    };
  };
