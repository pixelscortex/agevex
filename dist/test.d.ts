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
            activeTools?: {
                name: string;
                key: string;
            }[] | undefined;
            textConfig?: {
                worker: string;
                updateThread: string;
                getThread: string;
            } | undefined;
            models?: Record<string, string> | undefined;
            loopWaiting?: boolean | undefined;
            pinged?: boolean | undefined;
            recoveryAt?: number | undefined;
            recoveryJobId?: import("convex/values").GenericId<"_scheduled_functions"> | undefined;
            recoveryDelayMs?: number | undefined;
            modelSteps?: number | undefined;
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
            runId?: import("convex/values").GenericId<"runs"> | undefined;
            childRunId?: string | undefined;
            rootAssignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
            turnToken?: string | undefined;
            promptMessageId?: string | undefined;
            turnReport?: {
                resumeInboxId?: import("convex/values").GenericId<"inbox"> | undefined;
                promptMessageId: string;
                messageIds: string[];
                maxMessages: number;
            } | undefined;
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
                    effective?: boolean | undefined;
                    key: string;
                    messageId: string;
                    proposalId: import("convex/values").GenericId<"receipts">;
                    providerExecuted: boolean;
                    toolCallKey: ArrayBuffer;
                }[];
            } | undefined;
            lastSlice?: string | undefined;
            notesPending: number;
            agent: string;
            limits: {
                attachmentBytes: number;
                notesPending: number;
                maxDepth: number;
                messagesPerChild: number;
                parentNotesPerChild: number;
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
            turnStatus: "idle" | "running" | "queued" | "recovery_required";
            errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null;
            subject: string;
            threadId: string;
            runTurn: string;
            cancellationEpoch: number;
            cancelled: boolean;
            queuedMessages: number;
            nextSequence: number;
            nextTurn: number;
            activeRuns: number;
            nextRunSequence: number;
        }, {
            activeTools: import("convex/values").VArray<{
                name: string;
                key: string;
            }[] | undefined, import("convex/values").VObject<{
                name: string;
                key: string;
            }, {
                key: import("convex/values").VString<string, "required">;
                name: import("convex/values").VString<string, "required">;
            }, "required", "name" | "key">, "optional">;
            textConfig: import("convex/values").VObject<{
                worker: string;
                updateThread: string;
                getThread: string;
            } | undefined, {
                worker: import("convex/values").VString<string, "required">;
                updateThread: import("convex/values").VString<string, "required">;
                getThread: import("convex/values").VString<string, "required">;
            }, "optional", "worker" | "updateThread" | "getThread">;
            notesPending: import("convex/values").VFloat64<number, "required">;
            subject: import("convex/values").VString<string, "required">;
            agent: import("convex/values").VString<string, "required">;
            threadId: import("convex/values").VString<string, "required">;
            models: import("convex/values").VRecord<Record<string, string> | undefined, import("convex/values").VString<string, "required">, import("convex/values").VString<string, "required">, "optional", string>;
            runTurn: import("convex/values").VString<string, "required">;
            workflowId: import("convex/values").VString<string | undefined, "optional">;
            limits: import("convex/values").VObject<{
                attachmentBytes: number;
                notesPending: number;
                maxDepth: number;
                messagesPerChild: number;
                parentNotesPerChild: number;
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
                notesPending: import("convex/values").VFloat64<number, "required">;
                maxDepth: import("convex/values").VFloat64<number, "required">;
                messagesPerChild: import("convex/values").VFloat64<number, "required">;
                parentNotesPerChild: import("convex/values").VFloat64<number, "required">;
                rootLane: import("convex/values").VFloat64<number, "required">;
                childLane: import("convex/values").VFloat64<number, "required">;
                runLaunches: import("convex/values").VFloat64<number, "required">;
                runHops: import("convex/values").VFloat64<number, "required">;
                activeChildrenPerRoot: import("convex/values").VFloat64<number, "required">;
                taskLength: import("convex/values").VFloat64<number, "required">;
                queueLength: import("convex/values").VFloat64<number, "required">;
                slicesPerTurn: import("convex/values").VFloat64<number, "required">;
                leaseMs: import("convex/values").VFloat64<number, "required">;
            }, "required", "attachmentBytes" | "notesPending" | "maxDepth" | "messagesPerChild" | "parentNotesPerChild" | "rootLane" | "childLane" | "runLaunches" | "runHops" | "activeChildrenPerRoot" | "taskLength" | "queueLength" | "slicesPerTurn" | "leaseMs">;
            loopWaiting: import("convex/values").VBoolean<boolean | undefined, "optional">;
            pinged: import("convex/values").VBoolean<boolean | undefined, "optional">;
            recoveryAt: import("convex/values").VFloat64<number | undefined, "optional">;
            recoveryJobId: import("convex/values").VId<import("convex/values").GenericId<"_scheduled_functions"> | undefined, "optional">;
            recoveryDelayMs: import("convex/values").VFloat64<number | undefined, "optional">;
            modelSteps: import("convex/values").VFloat64<number | undefined, "optional">;
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
            }, "optional", "stream" | "messageId" | "executionId" | "epoch" | "getMessages" | "finalizeMessage" | "stream.id" | "stream.abort">;
            cancellationEpoch: import("convex/values").VFloat64<number, "required">;
            cancelled: import("convex/values").VBoolean<boolean, "required">;
            runId: import("convex/values").VId<import("convex/values").GenericId<"runs"> | undefined, "optional">;
            childRunId: import("convex/values").VString<string | undefined, "optional">;
            rootAssignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments"> | undefined, "optional">;
            turnStatus: import("convex/values").VUnion<"idle" | "running" | "queued" | "recovery_required", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"idle", "required">, import("convex/values").VLiteral<"recovery_required", "required">], "required", never>;
            errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"RUN_TIMEOUT", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">], "required", never>;
            queuedMessages: import("convex/values").VFloat64<number, "required">;
            nextSequence: import("convex/values").VFloat64<number, "required">;
            nextTurn: import("convex/values").VFloat64<number, "required">;
            turnToken: import("convex/values").VString<string | undefined, "optional">;
            promptMessageId: import("convex/values").VString<string | undefined, "optional">;
            turnReport: import("convex/values").VObject<{
                resumeInboxId?: import("convex/values").GenericId<"inbox"> | undefined;
                promptMessageId: string;
                messageIds: string[];
                maxMessages: number;
            } | undefined, {
                promptMessageId: import("convex/values").VString<string, "required">;
                messageIds: import("convex/values").VArray<string[], import("convex/values").VString<string, "required">, "required">;
                maxMessages: import("convex/values").VFloat64<number, "required">;
                resumeInboxId: import("convex/values").VId<import("convex/values").GenericId<"inbox"> | undefined, "optional">;
            }, "optional", "promptMessageId" | "messageIds" | "maxMessages" | "resumeInboxId">;
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
                    effective?: boolean | undefined;
                    key: string;
                    messageId: string;
                    proposalId: import("convex/values").GenericId<"receipts">;
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
                    effective?: boolean | undefined;
                    key: string;
                    messageId: string;
                    proposalId: import("convex/values").GenericId<"receipts">;
                    providerExecuted: boolean;
                    toolCallKey: ArrayBuffer;
                }[], import("convex/values").VObject<{
                    deferred?: boolean | undefined;
                    resolved?: true | undefined;
                    effective?: boolean | undefined;
                    key: string;
                    messageId: string;
                    proposalId: import("convex/values").GenericId<"receipts">;
                    providerExecuted: boolean;
                    toolCallKey: ArrayBuffer;
                }, {
                    deferred: import("convex/values").VBoolean<boolean | undefined, "optional">;
                    key: import("convex/values").VString<string, "required">;
                    messageId: import("convex/values").VString<string, "required">;
                    proposalId: import("convex/values").VId<import("convex/values").GenericId<"receipts">, "required">;
                    providerExecuted: import("convex/values").VBoolean<boolean, "required">;
                    toolCallKey: import("convex/values").VBytes<ArrayBuffer, "required">;
                    resolved: import("convex/values").VLiteral<true | undefined, "optional">;
                    effective: import("convex/values").VBoolean<boolean | undefined, "optional">;
                }, "required", "key" | "messageId" | "deferred" | "proposalId" | "providerExecuted" | "toolCallKey" | "resolved" | "effective">, "required">;
            }, "optional", "epoch" | "getMessages" | "inboxId" | "addMessages" | "cleanupPending" | "requests">;
            lastSlice: import("convex/values").VString<string | undefined, "optional">;
            activeRuns: import("convex/values").VFloat64<number, "required">;
            nextRunSequence: import("convex/values").VFloat64<number, "required">;
        }, "required", "workflowId" | "notesPending" | "agent" | "limits" | "turnStatus" | "errorCode" | "activeTools" | "textConfig" | "subject" | "threadId" | "models" | "runTurn" | "loopWaiting" | "pinged" | "recoveryAt" | "recoveryJobId" | "recoveryDelayMs" | "modelSteps" | "watchdogId" | "pendingGeneration" | "cancellationEpoch" | "cancelled" | "runId" | "childRunId" | "rootAssignmentId" | "queuedMessages" | "nextSequence" | "nextTurn" | "turnToken" | "promptMessageId" | "turnReport" | "turnOrigin" | "inboxId" | "approvalBlocked" | "approvals" | "lastSlice" | "activeRuns" | "nextRunSequence" | "limits.attachmentBytes" | "limits.notesPending" | "limits.maxDepth" | "limits.messagesPerChild" | "limits.parentNotesPerChild" | "limits.rootLane" | "limits.childLane" | "limits.runLaunches" | "limits.runHops" | "limits.activeChildrenPerRoot" | "limits.taskLength" | "limits.queueLength" | "limits.slicesPerTurn" | "limits.leaseMs" | "textConfig.worker" | "textConfig.updateThread" | "textConfig.getThread" | `models.${string}` | "pendingGeneration.stream" | "pendingGeneration.messageId" | "pendingGeneration.executionId" | "pendingGeneration.epoch" | "pendingGeneration.getMessages" | "pendingGeneration.finalizeMessage" | "pendingGeneration.stream.id" | "pendingGeneration.stream.abort" | "turnReport.promptMessageId" | "turnReport.messageIds" | "turnReport.maxMessages" | "turnReport.resumeInboxId" | "approvals.epoch" | "approvals.getMessages" | "approvals.inboxId" | "approvals.addMessages" | "approvals.cleanupPending" | "approvals.requests">, {
            by_thread: ["threadId", "_creationTime"];
        }, {}, {}>;
        inbox: import("convex/server").TableDefinition<import("convex/values").VObject<{
            from?: string | undefined;
            passive?: boolean | undefined;
            text?: string | undefined;
            noteEpoch?: number | undefined;
            kind: "result" | "user" | "parent" | "note";
            messageId: string;
            runId: import("convex/values").GenericId<"runs">;
            assignmentId: import("convex/values").GenericId<"assignments">;
            sequence: number;
        }, {
            assignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
            messageId: import("convex/values").VString<string, "required">;
            sequence: import("convex/values").VFloat64<number, "required">;
            passive: import("convex/values").VBoolean<boolean | undefined, "optional">;
            text: import("convex/values").VString<string | undefined, "optional">;
            noteEpoch: import("convex/values").VFloat64<number | undefined, "optional">;
            from: import("convex/values").VString<string | undefined, "optional">;
            runId: import("convex/values").VId<import("convex/values").GenericId<"runs">, "required">;
            kind: import("convex/values").VUnion<"result" | "user" | "parent" | "note", [import("convex/values").VLiteral<"user", "required">, import("convex/values").VLiteral<"result", "required">, import("convex/values").VLiteral<"parent", "required">, import("convex/values").VLiteral<"note", "required">], "required", never>;
        }, "required", "from" | "kind" | "messageId" | "runId" | "assignmentId" | "sequence" | "passive" | "text" | "noteEpoch">, {
            by_message: ["messageId", "_creationTime"];
            by_run_ready: ["assignmentId", "runId", "passive", "_creationTime"];
            by_assignment_ready: ["assignmentId", "passive", "noteEpoch", "sequence", "_creationTime"];
        }, {}, {}>;
        runs: import("convex/server").TableDefinition<import("convex/values").VObject<{
            startedAt?: number | undefined;
            settings?: {
                agent: string;
                settings: {
                    askUser?: boolean | undefined;
                    mode: "stream" | "generate";
                    maxOutputTokens: number;
                    modelTimeoutMs: number;
                    toolTimeoutMs: number;
                    stepsPerTurn: number;
                };
            }[] | undefined;
            errorCode?: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null | undefined;
            models?: Record<string, string> | undefined;
            rootAssignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
            rootCancellationEpoch?: number | undefined;
            taskMessageId?: string | undefined;
            turnEndedAt?: number | undefined;
            finishedAt?: number | undefined;
            resultMessageId?: string | undefined;
            usagePartial?: boolean | undefined;
            cancelled: boolean;
            launches: number;
            hops: number;
        }, {
            rootAssignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments"> | undefined, "optional">;
            rootCancellationEpoch: import("convex/values").VFloat64<number | undefined, "optional">;
            taskMessageId: import("convex/values").VString<string | undefined, "optional">;
            startedAt: import("convex/values").VFloat64<number | undefined, "optional">;
            turnEndedAt: import("convex/values").VFloat64<number | undefined, "optional">;
            finishedAt: import("convex/values").VFloat64<number | undefined, "optional">;
            errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | null | undefined, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"RUN_TIMEOUT", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">], "optional", never>;
            resultMessageId: import("convex/values").VString<string | undefined, "optional">;
            usagePartial: import("convex/values").VBoolean<boolean | undefined, "optional">;
            settings: import("convex/values").VArray<{
                agent: string;
                settings: {
                    askUser?: boolean | undefined;
                    mode: "stream" | "generate";
                    maxOutputTokens: number;
                    modelTimeoutMs: number;
                    toolTimeoutMs: number;
                    stepsPerTurn: number;
                };
            }[] | undefined, import("convex/values").VObject<{
                agent: string;
                settings: {
                    askUser?: boolean | undefined;
                    mode: "stream" | "generate";
                    maxOutputTokens: number;
                    modelTimeoutMs: number;
                    toolTimeoutMs: number;
                    stepsPerTurn: number;
                };
            }, {
                agent: import("convex/values").VString<string, "required">;
                settings: import("convex/values").VObject<{
                    askUser?: boolean | undefined;
                    mode: "stream" | "generate";
                    maxOutputTokens: number;
                    modelTimeoutMs: number;
                    toolTimeoutMs: number;
                    stepsPerTurn: number;
                }, {
                    askUser: import("convex/values").VBoolean<boolean | undefined, "optional">;
                    mode: import("convex/values").VUnion<"stream" | "generate", [import("convex/values").VLiteral<"stream", "required">, import("convex/values").VLiteral<"generate", "required">], "required", never>;
                    maxOutputTokens: import("convex/values").VFloat64<number, "required">;
                    modelTimeoutMs: import("convex/values").VFloat64<number, "required">;
                    toolTimeoutMs: import("convex/values").VFloat64<number, "required">;
                    stepsPerTurn: import("convex/values").VFloat64<number, "required">;
                }, "required", "askUser" | "mode" | "maxOutputTokens" | "modelTimeoutMs" | "toolTimeoutMs" | "stepsPerTurn">;
            }, "required", "agent" | "settings" | "settings.askUser" | "settings.mode" | "settings.maxOutputTokens" | "settings.modelTimeoutMs" | "settings.toolTimeoutMs" | "settings.stepsPerTurn">, "optional">;
            models: import("convex/values").VRecord<Record<string, string> | undefined, import("convex/values").VString<string, "required">, import("convex/values").VString<string, "required">, "optional", string>;
            launches: import("convex/values").VFloat64<number, "required">;
            hops: import("convex/values").VFloat64<number, "required">;
            cancelled: import("convex/values").VBoolean<boolean, "required">;
        }, "required", "startedAt" | "settings" | "errorCode" | "models" | "cancelled" | "rootAssignmentId" | `models.${string}` | "rootCancellationEpoch" | "taskMessageId" | "turnEndedAt" | "finishedAt" | "resultMessageId" | "usagePartial" | "launches" | "hops">, {
            by_root: ["rootAssignmentId", "_creationTime"];
        }, {}, {}>;
        receipts: import("convex/server").TableDefinition<import("convex/values").VUnion<{
            result: {
                schema?: any;
                truncated?: true | undefined;
                approved?: {
                    toolCallId: string;
                    input: any;
                    edited: boolean;
                    originalHash: string;
                    effectiveHash: string;
                } | undefined;
                id: string;
                providerExecuted: boolean;
                toolCallId: string;
                tool: string;
                input: any;
            };
            kind: "proposal";
        } | {
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
            result: {
                schema?: any;
                truncated?: true | undefined;
                approved?: {
                    toolCallId: string;
                    input: any;
                    edited: boolean;
                    originalHash: string;
                    effectiveHash: string;
                } | undefined;
                id: string;
                providerExecuted: boolean;
                toolCallId: string;
                tool: string;
                input: any;
            };
            kind: "proposal";
        }, {
            kind: import("convex/values").VLiteral<"proposal", "required">;
            result: import("convex/values").VObject<{
                schema?: any;
                truncated?: true | undefined;
                approved?: {
                    toolCallId: string;
                    input: any;
                    edited: boolean;
                    originalHash: string;
                    effectiveHash: string;
                } | undefined;
                id: string;
                providerExecuted: boolean;
                toolCallId: string;
                tool: string;
                input: any;
            }, {
                approved: import("convex/values").VObject<{
                    toolCallId: string;
                    input: any;
                    edited: boolean;
                    originalHash: string;
                    effectiveHash: string;
                } | undefined, {
                    edited: import("convex/values").VBoolean<boolean, "required">;
                    toolCallId: import("convex/values").VString<string, "required">;
                    input: import("convex/values").VAny<any, "required", string>;
                    originalHash: import("convex/values").VString<string, "required">;
                    effectiveHash: import("convex/values").VString<string, "required">;
                }, "optional", "toolCallId" | "input" | `input.${string}` | "edited" | "originalHash" | "effectiveHash">;
                id: import("convex/values").VString<string, "required">;
                toolCallId: import("convex/values").VString<string, "required">;
                tool: import("convex/values").VString<string, "required">;
                input: import("convex/values").VAny<any, "required", string>;
                providerExecuted: import("convex/values").VBoolean<boolean, "required">;
                schema: import("convex/values").VAny<any, "optional", string>;
                truncated: import("convex/values").VLiteral<true | undefined, "optional">;
            }, "required", "id" | "providerExecuted" | "toolCallId" | "tool" | "input" | "schema" | "truncated" | `input.${string}` | `schema.${string}` | "approved" | "approved.toolCallId" | "approved.input" | `approved.input.${string}` | "approved.edited" | "approved.originalHash" | "approved.effectiveHash">;
        }, "required", "result" | "kind" | "result.id" | "result.providerExecuted" | "result.toolCallId" | "result.tool" | "result.input" | "result.schema" | "result.truncated" | `result.input.${string}` | `result.schema.${string}` | "result.approved" | "result.approved.toolCallId" | "result.approved.input" | `result.approved.input.${string}` | "result.approved.edited" | "result.approved.originalHash" | "result.approved.effectiveHash">, import("convex/values").VObject<{
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
        }, "required", "kind" | "subject" | "threadId" | "messageId" | "native" | "fileId">], "required", "result" | "kind" | "status" | "key" | "subject" | "threadId" | "messageId" | `result.input.${string}` | `result.schema.${string}` | `result.approved.input.${string}` | "scope" | "fingerprint" | "claim" | "leaseUntil" | "expiresAt" | `result.${string}` | "native" | "fileId">, {
            by_scope_key: ["scope", "key", "_creationTime"];
            by_expiry: ["kind", "expiresAt", "_creationTime"];
            by_file: ["native", "fileId", "subject", "threadId", "_creationTime"];
            by_message: ["native", "messageId", "_creationTime"];
        }, {}, {}>;
        subagentRuns: import("convex/server").TableDefinition<import("convex/values").VObject<{
            startedAt?: number | undefined;
            taskMessageId?: string | undefined;
            resultMessageId?: string | undefined;
            questionMessageId?: string | undefined;
            lastParentNoteAt?: number | undefined;
            childAssignmentId?: import("convex/values").GenericId<"assignments"> | undefined;
            childThreadId?: string | undefined;
            childResultMessageId?: string | undefined;
            lastTurnResult?: {
                messageId?: string | undefined;
                errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
            } | undefined;
            events: {
                errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
                phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
                at: number;
            }[];
            status: "failed" | "running" | "completed" | "queued" | "asking";
            agent: string;
            errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
            runId: string;
            rootAssignmentId: import("convex/values").GenericId<"assignments">;
            sequence: number;
            rootCancellationEpoch: number;
            deliveryStatus: "failed" | "pending" | "accepted" | "blocked";
            parentRunId: import("convex/values").GenericId<"runs">;
            dedupKey: string;
            payloadFingerprint: string;
            actorAssignmentId: import("convex/values").GenericId<"assignments">;
            depth: number;
            messagesReceived: number;
            parentNotesSent: number;
            actorAgent: string;
            deliveryToken: string;
            coordinateHandle: string;
        }, {
            taskMessageId: import("convex/values").VString<string | undefined, "optional">;
            runId: import("convex/values").VString<string, "required">;
            rootCancellationEpoch: import("convex/values").VFloat64<number, "required">;
            parentRunId: import("convex/values").VId<import("convex/values").GenericId<"runs">, "required">;
            dedupKey: import("convex/values").VString<string, "required">;
            payloadFingerprint: import("convex/values").VString<string, "required">;
            rootAssignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
            actorAssignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
            depth: import("convex/values").VFloat64<number, "required">;
            questionMessageId: import("convex/values").VString<string | undefined, "optional">;
            messagesReceived: import("convex/values").VFloat64<number, "required">;
            parentNotesSent: import("convex/values").VFloat64<number, "required">;
            lastParentNoteAt: import("convex/values").VFloat64<number | undefined, "optional">;
            childAssignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments"> | undefined, "optional">;
            childThreadId: import("convex/values").VString<string | undefined, "optional">;
            childResultMessageId: import("convex/values").VString<string | undefined, "optional">;
            lastTurnResult: import("convex/values").VObject<{
                messageId?: string | undefined;
                errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
            } | undefined, {
                messageId: import("convex/values").VString<string | undefined, "optional">;
                errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"RUN_TIMEOUT", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">, import("convex/values").VLiteral<"EMPTY_RESULT", "required">, import("convex/values").VLiteral<"RESULT_UNVERIFIED", "required">, import("convex/values").VLiteral<"ROOT_UNAVAILABLE", "required">, import("convex/values").VLiteral<"DELIVERY_FAILED", "required">, import("convex/values").VLiteral<"DELIVERY_UNKNOWN", "required">], "required", never>;
            }, "optional", "errorCode" | "messageId">;
            agent: import("convex/values").VString<string, "required">;
            actorAgent: import("convex/values").VString<string, "required">;
            status: import("convex/values").VUnion<"failed" | "running" | "completed" | "queued" | "asking", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"asking", "required">, import("convex/values").VLiteral<"completed", "required">, import("convex/values").VLiteral<"failed", "required">], "required", never>;
            deliveryStatus: import("convex/values").VUnion<"failed" | "pending" | "accepted" | "blocked", [import("convex/values").VLiteral<"pending", "required">, import("convex/values").VLiteral<"accepted", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"blocked", "required">], "required", never>;
            errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"RUN_TIMEOUT", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">, import("convex/values").VLiteral<"EMPTY_RESULT", "required">, import("convex/values").VLiteral<"RESULT_UNVERIFIED", "required">, import("convex/values").VLiteral<"ROOT_UNAVAILABLE", "required">, import("convex/values").VLiteral<"DELIVERY_FAILED", "required">, import("convex/values").VLiteral<"DELIVERY_UNKNOWN", "required">], "required", never>;
            deliveryToken: import("convex/values").VString<string, "required">;
            coordinateHandle: import("convex/values").VString<string, "required">;
            sequence: import("convex/values").VFloat64<number, "required">;
            startedAt: import("convex/values").VFloat64<number | undefined, "optional">;
            resultMessageId: import("convex/values").VString<string | undefined, "optional">;
            events: import("convex/values").VArray<{
                errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
                phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
                at: number;
            }[], import("convex/values").VObject<{
                errorCode: "BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null;
                phase: "failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked";
                at: number;
            }, {
                phase: import("convex/values").VUnion<"failed" | "completed" | "started" | "queued" | "result_accepted" | "delivery_failed" | "delivery_blocked", [import("convex/values").VLiteral<"queued", "required">, import("convex/values").VLiteral<"started", "required">, import("convex/values").VLiteral<"completed", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"result_accepted", "required">, import("convex/values").VLiteral<"delivery_failed", "required">, import("convex/values").VLiteral<"delivery_blocked", "required">], "required", never>;
                at: import("convex/values").VFloat64<number, "required">;
                errorCode: import("convex/values").VUnion<"BUDGET_EXCEEDED" | "HOOK_FAILED" | "GENERATION_FAILED" | "RUN_TIMEOUT" | "SLICE_LIMIT" | "APPROVAL_LIMIT" | "CLEANUP_FAILED" | "AUTHORIZATION_DENIED" | "EXECUTION_AMBIGUOUS" | "EMPTY_RESULT" | "RESULT_UNVERIFIED" | "ROOT_UNAVAILABLE" | "DELIVERY_FAILED" | "DELIVERY_UNKNOWN" | null, [import("convex/values").VNull<null, "required">, import("convex/values").VLiteral<"BUDGET_EXCEEDED", "required">, import("convex/values").VLiteral<"HOOK_FAILED", "required">, import("convex/values").VLiteral<"GENERATION_FAILED", "required">, import("convex/values").VLiteral<"RUN_TIMEOUT", "required">, import("convex/values").VLiteral<"SLICE_LIMIT", "required">, import("convex/values").VLiteral<"APPROVAL_LIMIT", "required">, import("convex/values").VLiteral<"CLEANUP_FAILED", "required">, import("convex/values").VLiteral<"AUTHORIZATION_DENIED", "required">, import("convex/values").VLiteral<"EXECUTION_AMBIGUOUS", "required">, import("convex/values").VLiteral<"EMPTY_RESULT", "required">, import("convex/values").VLiteral<"RESULT_UNVERIFIED", "required">, import("convex/values").VLiteral<"ROOT_UNAVAILABLE", "required">, import("convex/values").VLiteral<"DELIVERY_FAILED", "required">, import("convex/values").VLiteral<"DELIVERY_UNKNOWN", "required">], "required", never>;
            }, "required", "errorCode" | "phase" | "at">, "required">;
        }, "required", "startedAt" | "events" | "status" | "agent" | "errorCode" | "runId" | "rootAssignmentId" | "sequence" | "rootCancellationEpoch" | "taskMessageId" | "resultMessageId" | "deliveryStatus" | "parentRunId" | "dedupKey" | "payloadFingerprint" | "actorAssignmentId" | "depth" | "questionMessageId" | "messagesReceived" | "parentNotesSent" | "lastParentNoteAt" | "childAssignmentId" | "childThreadId" | "childResultMessageId" | "lastTurnResult" | "actorAgent" | "deliveryToken" | "coordinateHandle" | "lastTurnResult.errorCode" | "lastTurnResult.messageId">, {
            by_result_message: ["resultMessageId", "_creationTime"];
            by_dedup: ["dedupKey", "_creationTime"];
            by_run: ["runId", "_creationTime"];
            by_root_sequence: ["rootAssignmentId", "sequence", "_creationTime"];
            by_root_status: ["rootAssignmentId", "status", "_creationTime"];
            by_parent_delivery: ["actorAssignmentId", "deliveryStatus", "rootCancellationEpoch", "parentRunId", "_creationTime"];
            by_parent_run: ["parentRunId", "actorAssignmentId", "_creationTime"];
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
