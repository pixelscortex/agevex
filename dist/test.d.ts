import type { TestConvex } from "convex-test";
import { type GenericSchema, type SchemaDefinition } from "convex/server";
import type { ComponentApi } from "./component/_generated/component.js";
/** Register Agevex and both nested Workflow/Workpool lanes, not the sibling native Agent. */
export declare function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(t: TestConvex<Schema>, name?: string): ComponentApi;
declare const _default: {
    register: typeof register;
    schema: SchemaDefinition<{
        assignments: import("convex/server").TableDefinition<import("convex/values").VObject<{
            workflowId?: string | undefined;
            runId?: import("convex/values").GenericId<"runs"> | undefined;
            modelStep?: {
                messageId: string;
                stepOrder: number;
            } | undefined;
            contextMessages?: {
                order: number;
                bytes: number;
                id: string;
                stepOrder: number;
                sequence: number;
            }[] | undefined;
            reviewed?: {
                agent: string;
                at: number;
                turn: number;
                boundary: number;
            }[] | undefined;
            routingAgentIndex?: number | undefined;
            hookContinue?: boolean | undefined;
            models?: Record<string, string> | undefined;
            loopWaiting?: boolean | undefined;
            pinged?: boolean | undefined;
            recoveryAt?: number | undefined;
            recoveryJobId?: import("convex/values").GenericId<"_scheduled_functions"> | undefined;
            recoveryDelayMs?: number | undefined;
            watchdogId?: import("convex/values").GenericId<"_scheduled_functions"> | undefined;
            pendingGeneration?: {
                stream?: {
                    id: string;
                    abort: string;
                } | undefined;
                messageId: string;
                executionId: string;
                epoch: number;
                getMessages: string;
                finalizeMessage: string;
            } | undefined;
            childRunId?: string | undefined;
            rootAssignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
            turnToken?: string | undefined;
            promptMessageId?: string | undefined;
            turnOrigin?: "user" | "subagent_result" | undefined;
            inboxId?: import("convex/values").GenericId<"inbox"> | undefined;
            approvalBlocked?: boolean | undefined;
            approvals?: {
                cleanupPending?: boolean | undefined;
                epoch: number;
                getMessages: string;
                inboxId: import("convex/values").GenericId<"inbox">;
                addMessages: string;
                requests: {
                    deferred?: boolean | undefined;
                    resolved?: true | undefined;
                    key: string;
                    messageId: string;
                    providerExecuted: boolean;
                    toolCallKey: ArrayBuffer;
                }[];
            } | undefined;
            lastSlice?: string | undefined;
            notesPending: number;
            agent: string;
            errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null;
            threadId: string;
            turnStatus: "idle" | "running" | "queued" | "recovery_required";
            queuedMessages: number;
            subject: string;
            limits: {
                attachmentBytes: number;
                continuesPerRun: number;
                sideRunsPerRun: number;
                notesPending: number;
                maxDepth: number;
                messagesPerChild: number;
                rootLane: number;
                childLane: number;
                runLaunches: number;
                runHops: number;
                activeChildrenPerRoot: number;
                taskLength: number;
                queueLength: number;
                slicesPerTurn: number;
                leaseMs: number;
            };
            completedTurns: number;
            runTurn: string;
            cancellationEpoch: number;
            cancelled: boolean;
            nextSequence: number;
            nextTurn: number;
            activeRuns: number;
            nextRunSequence: number;
        }, {
            modelStep: import("convex/values").VObject<{
                messageId: string;
                stepOrder: number;
            } | undefined, {
                messageId: import("convex/values").VString<string, "required">;
                stepOrder: import("convex/values").VFloat64<number, "required">;
            }, "optional", "messageId" | "stepOrder">;
            contextMessages: import("convex/values").VArray<{
                order: number;
                bytes: number;
                id: string;
                stepOrder: number;
                sequence: number;
            }[] | undefined, import("convex/values").VObject<{
                order: number;
                bytes: number;
                id: string;
                stepOrder: number;
                sequence: number;
            }, {
                id: import("convex/values").VString<string, "required">;
                order: import("convex/values").VFloat64<number, "required">;
                stepOrder: import("convex/values").VFloat64<number, "required">;
                bytes: import("convex/values").VFloat64<number, "required">;
                sequence: import("convex/values").VFloat64<number, "required">;
            }, "required", "order" | "bytes" | "id" | "stepOrder" | "sequence">, "optional">;
            reviewed: import("convex/values").VArray<{
                agent: string;
                at: number;
                turn: number;
                boundary: number;
            }[] | undefined, import("convex/values").VObject<{
                agent: string;
                at: number;
                turn: number;
                boundary: number;
            }, {
                agent: import("convex/values").VString<string, "required">;
                turn: import("convex/values").VFloat64<number, "required">;
                at: import("convex/values").VFloat64<number, "required">;
                boundary: import("convex/values").VFloat64<number, "required">;
            }, "required", "agent" | "at" | "turn" | "boundary">, "optional">;
            completedTurns: import("convex/values").VFloat64<number, "required">;
            notesPending: import("convex/values").VFloat64<number, "required">;
            routingAgentIndex: import("convex/values").VFloat64<number | undefined, "optional">;
            hookContinue: import("convex/values").VBoolean<boolean | undefined, "optional">;
            subject: import("convex/values").VString<string, "required">;
            agent: import("convex/values").VString<string, "required">;
            threadId: import("convex/values").VString<string, "required">;
            models: import("convex/values").VRecord<Record<string, string> | undefined, import("convex/values").VString<string, "required">, import("convex/values").VString<string, "required">, "optional", string>;
            runTurn: import("convex/values").VString<string, "required">;
            workflowId: import("convex/values").VString<string | undefined, "optional">;
            limits: import("convex/values").VObject<{
                attachmentBytes: number;
                continuesPerRun: number;
                sideRunsPerRun: number;
                notesPending: number;
                maxDepth: number;
                messagesPerChild: number;
                rootLane: number;
                childLane: number;
                runLaunches: number;
                runHops: number;
                activeChildrenPerRoot: number;
                taskLength: number;
                queueLength: number;
                slicesPerTurn: number;
                leaseMs: number;
            }, {
                attachmentBytes: import("convex/values").VFloat64<number, "required">;
                continuesPerRun: import("convex/values").VFloat64<number, "required">;
                sideRunsPerRun: import("convex/values").VFloat64<number, "required">;
                notesPending: import("convex/values").VFloat64<number, "required">;
                maxDepth: import("convex/values").VFloat64<number, "required">;
                messagesPerChild: import("convex/values").VFloat64<number, "required">;
                rootLane: import("convex/values").VFloat64<number, "required">;
                childLane: import("convex/values").VFloat64<number, "required">;
                runLaunches: import("convex/values").VFloat64<number, "required">;
                runHops: import("convex/values").VFloat64<number, "required">;
                activeChildrenPerRoot: import("convex/values").VFloat64<number, "required">;
                taskLength: import("convex/values").VFloat64<number, "required">;
                queueLength: import("convex/values").VFloat64<number, "required">;
                slicesPerTurn: import("convex/values").VFloat64<number, "required">;
                leaseMs: import("convex/values").VFloat64<number, "required">;
            }, "required", "attachmentBytes" | "continuesPerRun" | "sideRunsPerRun" | "notesPending" | "maxDepth" | "messagesPerChild" | "rootLane" | "childLane" | "runLaunches" | "runHops" | "activeChildrenPerRoot" | "taskLength" | "queueLength" | "slicesPerTurn" | "leaseMs">;
            loopWaiting: import("convex/values").VBoolean<boolean | undefined, "optional">;
            pinged: import("convex/values").VBoolean<boolean | undefined, "optional">;
            recoveryAt: import("convex/values").VFloat64<number | undefined, "optional">;
            recoveryJobId: import("convex/values").VId<import("convex/values").GenericId<"_scheduled_functions"> | undefined, "optional">;
            recoveryDelayMs: import("convex/values").VFloat64<number | undefined, "optional">;
            watchdogId: import("convex/values").VId<import("convex/values").GenericId<"_scheduled_functions"> | undefined, "optional">;
            pendingGeneration: import("convex/values").VObject<{
                stream?: {
                    id: string;
                    abort: string;
                } | undefined;
                messageId: string;
                executionId: string;
                epoch: number;
                getMessages: string;
                finalizeMessage: string;
            } | undefined, {
                messageId: import("convex/values").VString<string, "required">;
                executionId: import("convex/values").VString<string, "required">;
                epoch: import("convex/values").VFloat64<number, "required">;
                getMessages: import("convex/values").VString<string, "required">;
                finalizeMessage: import("convex/values").VString<string, "required">;
                stream: import("convex/values").VObject<{
                    id: string;
                    abort: string;
                } | undefined, {
                    id: import("convex/values").VString<string, "required">;
                    abort: import("convex/values").VString<string, "required">;
                }, "optional", "id" | "abort">;
            }, "optional", "messageId" | "executionId" | "epoch" | "getMessages" | "finalizeMessage" | "stream" | "stream.id" | "stream.abort">;
            cancellationEpoch: import("convex/values").VFloat64<number, "required">;
            cancelled: import("convex/values").VBoolean<boolean, "required">;
            runId: import("convex/values").VId<import("convex/values").GenericId<"runs"> | undefined, "optional">;
            childRunId: import("convex/values").VString<string | undefined, "optional">;
            rootAssignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments"> | undefined, "optional">;
            turnStatus: import("convex/values").VUnion<"idle" | "running" | "queued" | "recovery_required", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"idle", "required">, import("convex/values").VLiteral<"recovery_required", "required">], "required", never>;
            errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">], "required", never>;
            queuedMessages: import("convex/values").VFloat64<number, "required">;
            nextSequence: import("convex/values").VFloat64<number, "required">;
            nextTurn: import("convex/values").VFloat64<number, "required">;
            turnToken: import("convex/values").VString<string | undefined, "optional">;
            promptMessageId: import("convex/values").VString<string | undefined, "optional">;
            turnOrigin: import("convex/values").VUnion<"user" | "subagent_result" | undefined, [import("convex/values").VLiteral<"user", "required">, import("convex/values").VLiteral<"subagent_result", "required">], "optional", never>;
            inboxId: import("convex/values").VId<import("convex/values").GenericId<"inbox"> | undefined, "optional">;
            approvalBlocked: import("convex/values").VBoolean<boolean | undefined, "optional">;
            approvals: import("convex/values").VObject<{
                cleanupPending?: boolean | undefined;
                epoch: number;
                getMessages: string;
                inboxId: import("convex/values").GenericId<"inbox">;
                addMessages: string;
                requests: {
                    deferred?: boolean | undefined;
                    resolved?: true | undefined;
                    key: string;
                    messageId: string;
                    providerExecuted: boolean;
                    toolCallKey: ArrayBuffer;
                }[];
            } | undefined, {
                inboxId: import("convex/values").VId<import("convex/values").GenericId<"inbox">, "required">;
                epoch: import("convex/values").VFloat64<number, "required">;
                getMessages: import("convex/values").VString<string, "required">;
                addMessages: import("convex/values").VString<string, "required">;
                cleanupPending: import("convex/values").VBoolean<boolean | undefined, "optional">;
                requests: import("convex/values").VArray<{
                    deferred?: boolean | undefined;
                    resolved?: true | undefined;
                    key: string;
                    messageId: string;
                    providerExecuted: boolean;
                    toolCallKey: ArrayBuffer;
                }[], import("convex/values").VObject<{
                    deferred?: boolean | undefined;
                    resolved?: true | undefined;
                    key: string;
                    messageId: string;
                    providerExecuted: boolean;
                    toolCallKey: ArrayBuffer;
                }, {
                    deferred: import("convex/values").VBoolean<boolean | undefined, "optional">;
                    key: import("convex/values").VString<string, "required">;
                    messageId: import("convex/values").VString<string, "required">;
                    providerExecuted: import("convex/values").VBoolean<boolean, "required">;
                    toolCallKey: import("convex/values").VBytes<ArrayBuffer, "required">;
                    resolved: import("convex/values").VLiteral<true | undefined, "optional">;
                }, "required", "key" | "messageId" | "deferred" | "providerExecuted" | "toolCallKey" | "resolved">, "required">;
            }, "optional", "epoch" | "getMessages" | "inboxId" | "addMessages" | "cleanupPending" | "requests">;
            lastSlice: import("convex/values").VString<string | undefined, "optional">;
            activeRuns: import("convex/values").VFloat64<number, "required">;
            nextRunSequence: import("convex/values").VFloat64<number, "required">;
        }, "required", "workflowId" | "notesPending" | "agent" | "errorCode" | "threadId" | "turnStatus" | "queuedMessages" | "runId" | "subject" | "limits" | "modelStep" | "contextMessages" | "reviewed" | "completedTurns" | "routingAgentIndex" | "hookContinue" | "models" | "runTurn" | "loopWaiting" | "pinged" | "recoveryAt" | "recoveryJobId" | "recoveryDelayMs" | "watchdogId" | "pendingGeneration" | "cancellationEpoch" | "cancelled" | "childRunId" | "rootAssignmentId" | "nextSequence" | "nextTurn" | "turnToken" | "promptMessageId" | "turnOrigin" | "inboxId" | "approvalBlocked" | "approvals" | "lastSlice" | "activeRuns" | "nextRunSequence" | "limits.attachmentBytes" | "limits.continuesPerRun" | "limits.sideRunsPerRun" | "limits.notesPending" | "limits.maxDepth" | "limits.messagesPerChild" | "limits.rootLane" | "limits.childLane" | "limits.runLaunches" | "limits.runHops" | "limits.activeChildrenPerRoot" | "limits.taskLength" | "limits.queueLength" | "limits.slicesPerTurn" | "limits.leaseMs" | "modelStep.messageId" | "modelStep.stepOrder" | `models.${string}` | "pendingGeneration.messageId" | "pendingGeneration.executionId" | "pendingGeneration.epoch" | "pendingGeneration.getMessages" | "pendingGeneration.finalizeMessage" | "pendingGeneration.stream" | "pendingGeneration.stream.id" | "pendingGeneration.stream.abort" | "approvals.epoch" | "approvals.getMessages" | "approvals.inboxId" | "approvals.addMessages" | "approvals.cleanupPending" | "approvals.requests">, {
            by_thread: ["threadId", "_creationTime"];
        }, {}, {}>;
        inbox: import("convex/server").TableDefinition<import("convex/values").VObject<{
            from?: string | undefined;
            join?: {
                newestSequence: number;
                earliestId: string;
                earliestSequence: number;
            } | undefined;
            passive?: boolean | undefined;
            text?: string | undefined;
            noteEpoch?: number | undefined;
            kind: "result" | "user" | "parent" | "note" | "continue";
            assignmentId: import("convex/values").GenericId<"assignments">;
            runId: import("convex/values").GenericId<"runs">;
            messageId: string;
            sequence: number;
        }, {
            assignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
            messageId: import("convex/values").VString<string, "required">;
            sequence: import("convex/values").VFloat64<number, "required">;
            passive: import("convex/values").VBoolean<boolean | undefined, "optional">;
            text: import("convex/values").VString<string | undefined, "optional">;
            noteEpoch: import("convex/values").VFloat64<number | undefined, "optional">;
            from: import("convex/values").VString<string | undefined, "optional">;
            join: import("convex/values").VObject<{
                newestSequence: number;
                earliestId: string;
                earliestSequence: number;
            } | undefined, {
                newestSequence: import("convex/values").VFloat64<number, "required">;
                earliestId: import("convex/values").VString<string, "required">;
                earliestSequence: import("convex/values").VFloat64<number, "required">;
            }, "optional", "newestSequence" | "earliestId" | "earliestSequence">;
            runId: import("convex/values").VId<import("convex/values").GenericId<"runs">, "required">;
            kind: import("convex/values").VUnion<"result" | "user" | "parent" | "note" | "continue", [import("convex/values").VLiteral<"user", "required">, import("convex/values").VLiteral<"result", "required">, import("convex/values").VLiteral<"parent", "required">, import("convex/values").VLiteral<"note", "required">, import("convex/values").VLiteral<"continue", "required">], "required", never>;
        }, "required", "from" | "join" | "kind" | "assignmentId" | "runId" | "messageId" | "sequence" | "passive" | "text" | "noteEpoch" | "join.newestSequence" | "join.earliestId" | "join.earliestSequence">, {
            by_message: ["messageId", "_creationTime"];
            by_assignment_ready: ["assignmentId", "passive", "noteEpoch", "sequence", "_creationTime"];
        }, {}, {}>;
        runs: import("convex/server").TableDefinition<import("convex/values").VObject<{
            models?: Record<string, string> | undefined;
            cancelled: boolean;
            startedAgents: bigint;
            routingAgents: bigint;
            continues: number;
            sideRuns: number;
            launches: number;
            hops: number;
        }, {
            models: import("convex/values").VRecord<Record<string, string> | undefined, import("convex/values").VString<string, "required">, import("convex/values").VString<string, "required">, "optional", string>;
            startedAgents: import("convex/values").VInt64<bigint, "required">;
            routingAgents: import("convex/values").VInt64<bigint, "required">;
            continues: import("convex/values").VFloat64<number, "required">;
            sideRuns: import("convex/values").VFloat64<number, "required">;
            launches: import("convex/values").VFloat64<number, "required">;
            hops: import("convex/values").VFloat64<number, "required">;
            cancelled: import("convex/values").VBoolean<boolean, "required">;
        }, "required", "models" | "cancelled" | `models.${string}` | "startedAgents" | "routingAgents" | "continues" | "sideRuns" | "launches" | "hops">, {}, {}, {}>;
        receipts: import("convex/server").TableDefinition<import("convex/values").VUnion<{
            result?: any;
            claim?: string | undefined;
            leaseUntil?: number | undefined;
            kind: "effect";
            status: "failed" | "running" | "done" | "unknown";
            key: string;
            scope: string;
            fingerprint: string;
            expiresAt: number;
        } | {
            threadId?: string | undefined;
            messageId?: string | undefined;
            kind: "attachment";
            subject: string;
            native: string;
            fileId: string;
        }, [import("convex/values").VObject<{
            result?: any;
            claim?: string | undefined;
            leaseUntil?: number | undefined;
            kind: "effect";
            status: "failed" | "running" | "done" | "unknown";
            key: string;
            scope: string;
            fingerprint: string;
            expiresAt: number;
        }, {
            kind: import("convex/values").VLiteral<"effect", "required">;
            scope: import("convex/values").VString<string, "required">;
            key: import("convex/values").VString<string, "required">;
            fingerprint: import("convex/values").VString<string, "required">;
            status: import("convex/values").VUnion<"failed" | "running" | "done" | "unknown", [import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"done", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"unknown", "required">], "required", never>;
            claim: import("convex/values").VString<string | undefined, "optional">;
            leaseUntil: import("convex/values").VFloat64<number | undefined, "optional">;
            result: import("convex/values").VAny<any, "optional", string>;
            expiresAt: import("convex/values").VFloat64<number, "required">;
        }, "required", "result" | "kind" | "status" | "key" | "scope" | "fingerprint" | "claim" | "leaseUntil" | "expiresAt" | `result.${string}`>, import("convex/values").VObject<{
            threadId?: string | undefined;
            messageId?: string | undefined;
            kind: "attachment";
            subject: string;
            native: string;
            fileId: string;
        }, {
            kind: import("convex/values").VLiteral<"attachment", "required">;
            native: import("convex/values").VString<string, "required">;
            fileId: import("convex/values").VString<string, "required">;
            subject: import("convex/values").VString<string, "required">;
            threadId: import("convex/values").VString<string | undefined, "optional">;
            messageId: import("convex/values").VString<string | undefined, "optional">;
        }, "required", "kind" | "threadId" | "subject" | "messageId" | "native" | "fileId">], "required", "result" | "kind" | "status" | "key" | "threadId" | "subject" | "messageId" | "scope" | "fingerprint" | "claim" | "leaseUntil" | "expiresAt" | `result.${string}` | "native" | "fileId">, {
            by_scope_key: ["scope", "key", "_creationTime"];
            by_expiry: ["kind", "expiresAt", "_creationTime"];
            by_file: ["native", "fileId", "subject", "threadId", "_creationTime"];
            by_message: ["native", "messageId", "_creationTime"];
        }, {}, {}>;
        subagentRuns: import("convex/server").TableDefinition<import("convex/values").VObject<{
            join?: "open" | "sealed" | "ready" | "joined" | undefined;
            startedAt?: number | undefined;
            side?: boolean | undefined;
            childThreadId?: string | undefined;
            resultMessageId?: string | undefined;
            group?: string | undefined;
            questionMessageId?: string | undefined;
            childAssignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
            childResultMessageId?: string | undefined;
            lastTurnResult?: {
                messageId?: string | undefined;
                errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
            } | undefined;
            resultSequence?: number | undefined;
            events: {
                phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
                at: number;
                errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
            }[];
            status: "failed" | "running" | "completed" | "queued" | "asking";
            agent: string;
            errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
            runId: string;
            deliveryStatus: "failed" | "pending" | "accepted" | "blocked";
            createdAt: number;
            sequence: number;
            rootAssignmentId: import("convex/values").GenericId<"assignments">;
            rootCancellationEpoch: number;
            parentRunId: import("convex/values").GenericId<"runs">;
            dedupKey: string;
            payloadFingerprint: string;
            actorAssignmentId: import("convex/values").GenericId<"assignments">;
            depth: number;
            messagesReceived: number;
            actorAgent: string;
            deliveryToken: string;
            coordinateHandle: string;
        }, {
            side: import("convex/values").VBoolean<boolean | undefined, "optional">;
            runId: import("convex/values").VString<string, "required">;
            rootCancellationEpoch: import("convex/values").VFloat64<number, "required">;
            parentRunId: import("convex/values").VId<import("convex/values").GenericId<"runs">, "required">;
            dedupKey: import("convex/values").VString<string, "required">;
            payloadFingerprint: import("convex/values").VString<string, "required">;
            rootAssignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
            actorAssignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
            depth: import("convex/values").VFloat64<number, "required">;
            group: import("convex/values").VString<string | undefined, "optional">;
            join: import("convex/values").VUnion<"open" | "sealed" | "ready" | "joined" | undefined, [import("convex/values").VLiteral<"open", "required">, import("convex/values").VLiteral<"sealed", "required">, import("convex/values").VLiteral<"ready", "required">, import("convex/values").VLiteral<"joined", "required">], "optional", never>;
            questionMessageId: import("convex/values").VString<string | undefined, "optional">;
            messagesReceived: import("convex/values").VFloat64<number, "required">;
            childAssignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments"> | undefined, "optional">;
            childThreadId: import("convex/values").VString<string | undefined, "optional">;
            childResultMessageId: import("convex/values").VString<string | undefined, "optional">;
            lastTurnResult: import("convex/values").VObject<{
                messageId?: string | undefined;
                errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
            } | undefined, {
                messageId: import("convex/values").VString<string | undefined, "optional">;
                errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">, import("convex/values").VLiteral<"EMPTY_RESULT", "required">, import("convex/values").VLiteral<"RESULT_UNVERIFIED", "required">, import("convex/values").VLiteral<"ROOT_UNAVAILABLE", "required">, import("convex/values").VLiteral<"DELIVERY_FAILED", "required">], "required", never>;
            }, "optional", "errorCode" | "messageId">;
            agent: import("convex/values").VString<string, "required">;
            actorAgent: import("convex/values").VString<string, "required">;
            status: import("convex/values").VUnion<"failed" | "running" | "completed" | "queued" | "asking", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"asking", "required">, import("convex/values").VLiteral<"completed", "required">, import("convex/values").VLiteral<"failed", "required">], "required", never>;
            deliveryStatus: import("convex/values").VUnion<"failed" | "pending" | "accepted" | "blocked", [import("convex/values").VLiteral<"pending", "required">, import("convex/values").VLiteral<"accepted", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"blocked", "required">], "required", never>;
            errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">, import("convex/values").VLiteral<"EMPTY_RESULT", "required">, import("convex/values").VLiteral<"RESULT_UNVERIFIED", "required">, import("convex/values").VLiteral<"ROOT_UNAVAILABLE", "required">, import("convex/values").VLiteral<"DELIVERY_FAILED", "required">], "required", never>;
            deliveryToken: import("convex/values").VString<string, "required">;
            coordinateHandle: import("convex/values").VString<string, "required">;
            createdAt: import("convex/values").VFloat64<number, "required">;
            sequence: import("convex/values").VFloat64<number, "required">;
            startedAt: import("convex/values").VFloat64<number | undefined, "optional">;
            resultMessageId: import("convex/values").VString<string | undefined, "optional">;
            resultSequence: import("convex/values").VFloat64<number | undefined, "optional">;
            events: import("convex/values").VArray<{
                phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
                at: number;
                errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
            }[], import("convex/values").VObject<{
                phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
                at: number;
                errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null;
            }, {
                phase: import("convex/values").VUnion<"failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"started", "required">, import("convex/values").VLiteral<"completed", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"result_accepted", "required">, import("convex/values").VLiteral<"delivery_failed", "required">, import("convex/values").VLiteral<"delivery_blocked", "required">], "required", never>;
                at: import("convex/values").VFloat64<number, "required">;
                errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">, import("convex/values").VLiteral<"EMPTY_RESULT", "required">, import("convex/values").VLiteral<"RESULT_UNVERIFIED", "required">, import("convex/values").VLiteral<"ROOT_UNAVAILABLE", "required">, import("convex/values").VLiteral<"DELIVERY_FAILED", "required">], "required", never>;
            }, "required", "phase" | "at" | "errorCode">, "required">;
        }, "required", "join" | "startedAt" | "events" | "status" | "agent" | "errorCode" | "runId" | "side" | "childThreadId" | "deliveryStatus" | "createdAt" | "resultMessageId" | "sequence" | "rootAssignmentId" | "rootCancellationEpoch" | "parentRunId" | "dedupKey" | "payloadFingerprint" | "actorAssignmentId" | "depth" | "group" | "questionMessageId" | "messagesReceived" | "childAssignmentId" | "childResultMessageId" | "lastTurnResult" | "actorAgent" | "deliveryToken" | "coordinateHandle" | "resultSequence" | "lastTurnResult.errorCode" | "lastTurnResult.messageId">, {
            by_result_message: ["resultMessageId", "_creationTime"];
            by_dedup: ["dedupKey", "_creationTime"];
            by_run: ["runId", "_creationTime"];
            by_root_sequence: ["rootAssignmentId", "sequence", "_creationTime"];
            by_root_status: ["rootAssignmentId", "status", "_creationTime"];
            by_parent_delivery: ["actorAssignmentId", "side", "deliveryStatus", "_creationTime"];
            by_join: ["actorAssignmentId", "rootCancellationEpoch", "join", "parentRunId", "_creationTime"];
            by_group: ["parentRunId", "actorAssignmentId", "group", "_creationTime"];
        }, {}, {}>;
    }, true>;
    modules: Record<string, () => Promise<unknown>>;
};
export default _default;
import type { LanguageModelV4Content } from "@ai-sdk/provider";
/**
 * Native mockModel currently emits finishReason=stop even for tool calls. Keep
 * its real streaming backend and adjust that one provider fact so scripted
 * tests exercise the same slice continuation as real tool-capable providers.
 */
export declare function scriptedModel(steps: LanguageModelV4Content[][]): import("@ai-sdk/provider").LanguageModelV4;
/** Same real Workflow/Workpool stack, plus journal inspection for tests only. */
export declare function registerWorkflow<Schema extends SchemaDefinition<GenericSchema, boolean>>(t: TestConvex<Schema>, name: string): void;
export { expectJournalUnchanged } from "./testing/expect-journal.js";
