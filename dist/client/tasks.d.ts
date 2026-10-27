import { type LanguageModel } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type { z } from "zod";
import type { ComponentApi } from "../component/_generated/component.js";
import type { SlotFacts, UsageSlot } from "./slots.js";
import { type UsageDeliveryGuard } from "./turn/usage.js";
type TaskModel = Extract<LanguageModel, string | LanguageModelV4>;
export type Task<Input, Output> = {
    name: string;
    input: z.ZodType<Input>;
    output: z.ZodType<Output>;
    prompt: (input: Input) => string;
    /** Sent as the model's system message, separate from the prompt (the user
     * message). Bounded like the prompt; repair attempts reuse it unchanged. */
    instructions?: string | ((input: Input) => string);
    model?: TaskModel;
    repair?: 0 | 1;
};
export type TaskOptions = {
    key?: string;
    component?: ComponentApi;
    attribution?: SlotFacts;
    usage?: UsageSlot;
    model?: TaskModel;
    leaseMs?: number;
    signal?: AbortSignal;
    /** Bounded overrides for small background calls and their exact-message input. */
    maxOutputTokens?: number;
    maxPromptLength?: number;
    /** Final admission immediately before each provider dispatch, after model resolution. */
    beforeDispatch?: () => Promise<void>;
};
export type TaskOutcome<Output> = {
    status: "done";
    value: Output;
} | {
    status: "running" | "unknown";
} | {
    status: "failed";
    code: "TASK_FAILED" | "INVALID_OUTPUT";
} | {
    status: "denied";
    code: "KEY_CONFLICT" | "CANCELLED";
};
type ActionCtx = GenericActionCtx<GenericDataModel>;
type Binding = {
    component: ComponentApi;
    attribution: SlotFacts;
    usage?: UsageSlot;
    turnKey: string;
    fence?: {
        assignmentId: string;
        executionId: string;
        cancellationEpoch: number;
    };
    usageDelivery?: {
        ctx: ActionCtx;
        guard: UsageDeliveryGuard;
    };
};
/**
 * Bind a turn's attribution, key, usage slot and fence to its fenced action
 * context, so `runTask(hc.ctx, …)` inside a hook needs no options.
 */
export declare function bindTaskContext(ctx: ActionCtx, binding: Binding): void;
/** Thin schema/prompt declaration. SDK Output.object owns parsing and validation
 * (ai/src/generate-text/output.ts:127-167); receipts only guard paid admission. */
export declare function defineTask<Input, Output>(task: Task<Input, Output>): Task<Input, Output>;
/**
 * Run one structured task at most once per key.
 *
 * Returns the stored outcome for a repeated key, `running` while another call
 * holds the claim, `unknown` when a paid call's outcome cannot be known (it is
 * never retried), and `denied` for a key reused with a different payload or a
 * cancelled turn.
 */
export declare function runTask<Input, Output>(context: ActionCtx | {
    ctx: ActionCtx;
    signal: AbortSignal;
}, task: Task<Input, Output>, input: Input, options?: TaskOptions): Promise<TaskOutcome<Output>>;
export {};
