import { type Infer } from "convex/values";
import type { MutationCtx } from "../_generated/server.js";
import type { Id } from "../_generated/dataModel.js";
import { noteHandles } from "../hooks/notes.js";
export declare const claimArgs: {
    assignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
    turnToken: import("convex/values").VString<string, "required">;
    sliceId: import("convex/values").VString<string | undefined, "optional">;
    agentIndex: import("convex/values").VFloat64<number | undefined, "optional">;
    routeModel: import("convex/values").VBoolean<boolean | undefined, "optional">;
    notes: import("convex/values").VObject<{
        getMessages: string;
        addMessages: string;
        updateMessage: string;
    } | undefined, {
        getMessages: import("convex/values").VString<string, "required">;
        addMessages: import("convex/values").VString<string, "required">;
        updateMessage: import("convex/values").VString<string, "required">;
    }, "optional", "getMessages" | "addMessages" | "updateMessage">;
};
/** The execution scope of a claimed slice; `subagent` is set for children. */
export declare const vClaim: import("convex/values").VObject<{
    modelId?: string | undefined;
    agent: string;
    settings: {
        mode: "stream" | "generate";
        maxOutputTokens: number;
        modelTimeoutMs: number;
        toolTimeoutMs: number;
        stepsPerTurn: number;
    };
    runId: string;
    assignmentId: string;
    threadId: string;
    subject: string;
    turn: number;
    cancellationEpoch: number;
    promptMessageId: string;
    turnOrigin: "user" | "subagent_result";
    isTurnStart: boolean;
    isRunStart: boolean;
    subagent: {
        agent: string;
        runId: string;
        subject: string;
        childThreadId: string;
        rootAssignmentId: string;
        actorAgent: string;
        deliveryToken: string;
        rootAgent: string;
        rootThreadId: string;
    } | null;
}, {
    promptMessageId: import("convex/values").VString<string, "required">;
    runId: import("convex/values").VString<string, "required">;
    modelId: import("convex/values").VString<string | undefined, "optional">;
    settings: import("convex/values").VObject<{
        mode: "stream" | "generate";
        maxOutputTokens: number;
        modelTimeoutMs: number;
        toolTimeoutMs: number;
        stepsPerTurn: number;
    }, {
        mode: import("convex/values").VUnion<"stream" | "generate", [import("convex/values").VLiteral<"stream", "required">, import("convex/values").VLiteral<"generate", "required">], "required", never>;
        maxOutputTokens: import("convex/values").VFloat64<number, "required">;
        modelTimeoutMs: import("convex/values").VFloat64<number, "required">;
        toolTimeoutMs: import("convex/values").VFloat64<number, "required">;
        stepsPerTurn: import("convex/values").VFloat64<number, "required">;
    }, "required", "mode" | "maxOutputTokens" | "modelTimeoutMs" | "toolTimeoutMs" | "stepsPerTurn">;
    isTurnStart: import("convex/values").VBoolean<boolean, "required">;
    isRunStart: import("convex/values").VBoolean<boolean, "required">;
    turn: import("convex/values").VFloat64<number, "required">;
    cancellationEpoch: import("convex/values").VFloat64<number, "required">;
    turnOrigin: import("convex/values").VUnion<"user" | "subagent_result", [import("convex/values").VLiteral<"user", "required">, import("convex/values").VLiteral<"subagent_result", "required">], "required", never>;
    subagent: import("convex/values").VUnion<{
        agent: string;
        runId: string;
        subject: string;
        childThreadId: string;
        rootAssignmentId: string;
        actorAgent: string;
        deliveryToken: string;
        rootAgent: string;
        rootThreadId: string;
    } | null, [import("convex/values").VNull<null, "required">, import("convex/values").VObject<{
        agent: string;
        runId: string;
        subject: string;
        childThreadId: string;
        rootAssignmentId: string;
        actorAgent: string;
        deliveryToken: string;
        rootAgent: string;
        rootThreadId: string;
    }, {
        runId: import("convex/values").VString<string, "required">;
        agent: import("convex/values").VString<string, "required">;
        rootAgent: import("convex/values").VString<string, "required">;
        actorAgent: import("convex/values").VString<string, "required">;
        subject: import("convex/values").VString<string, "required">;
        rootAssignmentId: import("convex/values").VString<string, "required">;
        rootThreadId: import("convex/values").VString<string, "required">;
        childThreadId: import("convex/values").VString<string, "required">;
        deliveryToken: import("convex/values").VString<string, "required">;
    }, "required", "agent" | "runId" | "subject" | "childThreadId" | "rootAssignmentId" | "actorAgent" | "deliveryToken" | "rootAgent" | "rootThreadId">], "required", "agent" | "runId" | "subject" | "childThreadId" | "rootAssignmentId" | "actorAgent" | "deliveryToken" | "rootAgent" | "rootThreadId">;
    assignmentId: import("convex/values").VString<string, "required">;
    threadId: import("convex/values").VString<string, "required">;
    subject: import("convex/values").VString<string, "required">;
    agent: import("convex/values").VString<string, "required">;
}, "required", "agent" | "settings" | "settings.mode" | "settings.maxOutputTokens" | "settings.modelTimeoutMs" | "settings.toolTimeoutMs" | "settings.stepsPerTurn" | "runId" | "assignmentId" | "threadId" | "subject" | "turn" | "cancellationEpoch" | "promptMessageId" | "turnOrigin" | "modelId" | "isTurnStart" | "isRunStart" | "subagent" | "subagent.agent" | "subagent.runId" | "subagent.subject" | "subagent.childThreadId" | "subagent.rootAssignmentId" | "subagent.actorAgent" | "subagent.deliveryToken" | "subagent.rootAgent" | "subagent.rootThreadId">;
type ClaimArgs = {
    assignmentId: Id<"assignments">;
    turnToken: string;
    sliceId?: string;
    agentIndex?: number;
    routeModel?: boolean;
    notes?: Infer<typeof noteHandles>;
};
type Claim = Infer<typeof vClaim>;
/** Claim the next slice of `turnToken`, or return null when this call may not
 * run one (stale token, cancelled, paused for approvals or a question, a
 * replayed slice id, or a corrupt child launch, which is escalated). */
export declare function claimSlice(ctx: MutationCtx, args: ClaimArgs): Promise<Claim | null>;
export {};
