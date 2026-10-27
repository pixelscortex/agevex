import { type Infer } from "convex/values";
import type { MutationCtx } from "../_generated/server.js";
import type { Id } from "../_generated/dataModel.js";
import { noteHandles } from "../hooks/notes.js";
export declare const claimArgs: {
    assignmentId: import("convex/values").VId<import("convex/values").GenericId<"assignments">, "required">;
    turnToken: import("convex/values").VString<string, "required">;
    sliceId: import("convex/values").VString<string | undefined, "optional">;
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
        askUser?: boolean | undefined;
        mode: "stream" | "generate";
        maxOutputTokens: number;
        modelTimeoutMs: number;
        toolTimeoutMs: number;
        stepsPerTurn: number;
    };
    subject: string;
    threadId: string;
    cancellationEpoch: number;
    runId: string;
    promptMessageId: string;
    turnOrigin: "user" | "subagent_result";
    assignmentId: string;
    requestMessageId: string;
    isTurnStart: boolean;
    turn: number;
    subagent: {
        agent: string;
        subject: string;
        runId: string;
        rootAssignmentId: string;
        childThreadId: string;
        actorAgent: string;
        deliveryToken: string;
        rootThreadId: string;
        rootAgent: string;
    } | null;
}, {
    promptMessageId: import("convex/values").VString<string, "required">;
    requestMessageId: import("convex/values").VString<string, "required">;
    runId: import("convex/values").VString<string, "required">;
    modelId: import("convex/values").VString<string | undefined, "optional">;
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
    isTurnStart: import("convex/values").VBoolean<boolean, "required">;
    turn: import("convex/values").VFloat64<number, "required">;
    cancellationEpoch: import("convex/values").VFloat64<number, "required">;
    turnOrigin: import("convex/values").VUnion<"user" | "subagent_result", [import("convex/values").VLiteral<"user", "required">, import("convex/values").VLiteral<"subagent_result", "required">], "required", never>;
    subagent: import("convex/values").VUnion<{
        agent: string;
        subject: string;
        runId: string;
        rootAssignmentId: string;
        childThreadId: string;
        actorAgent: string;
        deliveryToken: string;
        rootThreadId: string;
        rootAgent: string;
    } | null, [import("convex/values").VNull<null, "required">, import("convex/values").VObject<{
        agent: string;
        subject: string;
        runId: string;
        rootAssignmentId: string;
        childThreadId: string;
        actorAgent: string;
        deliveryToken: string;
        rootThreadId: string;
        rootAgent: string;
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
    }, "required", "agent" | "subject" | "runId" | "rootAssignmentId" | "childThreadId" | "actorAgent" | "deliveryToken" | "rootThreadId" | "rootAgent">], "required", "agent" | "subject" | "runId" | "rootAssignmentId" | "childThreadId" | "actorAgent" | "deliveryToken" | "rootThreadId" | "rootAgent">;
    assignmentId: import("convex/values").VString<string, "required">;
    threadId: import("convex/values").VString<string, "required">;
    subject: import("convex/values").VString<string, "required">;
    agent: import("convex/values").VString<string, "required">;
}, "required", "agent" | "settings" | "settings.askUser" | "settings.mode" | "settings.maxOutputTokens" | "settings.modelTimeoutMs" | "settings.toolTimeoutMs" | "settings.stepsPerTurn" | "subject" | "threadId" | "cancellationEpoch" | "runId" | "promptMessageId" | "turnOrigin" | "assignmentId" | "modelId" | "requestMessageId" | "isTurnStart" | "turn" | "subagent" | "subagent.agent" | "subagent.subject" | "subagent.runId" | "subagent.rootAssignmentId" | "subagent.childThreadId" | "subagent.actorAgent" | "subagent.deliveryToken" | "subagent.rootThreadId" | "subagent.rootAgent">;
type ClaimArgs = {
    assignmentId: Id<"assignments">;
    turnToken: string;
    sliceId?: string;
    notes?: Infer<typeof noteHandles>;
};
type Claim = Infer<typeof vClaim>;
/** Claim the next slice of `turnToken`, or return null when this call may not
 * run one (stale token, cancelled, paused for approvals or a question, a
 * replayed slice id, or a corrupt child launch, which is escalated). */
export declare function claimSlice(ctx: MutationCtx, args: ClaimArgs): Promise<Claim | null>;
export {};
