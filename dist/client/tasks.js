// Structured tasks: one bounded, schema-validated model call with a receipt.
//
// `defineTask` declares a task (name, input/output schemas, prompt); `runTask`
// runs it at most once per idempotency key through the core receipts ledger
// (`receipts.effects.begin` → `receipts.effects.complete` /
// `receipts.effects.unknown`), with at most one repair re-ask for invalid
// structured output and never a retry of an unknown paid outcome. Inside a turn, `bindTaskContext` (called by `turn/generation.ts`)
// lets hooks call `runTask` with the turn's attribution, key and cancellation
// fence; outside a turn `registerAgent(...).runTask` supplies the component.
import { wrapLanguageModel, generateText, Output, NoObjectGeneratedError, } from "ai";
import { convexToJson, getConvexSize } from "convex/values";
import { TEXT_LIMITS } from "../component/text/values.js";
import { HOST_LIMITS, LIMITS } from "../component/limits.js";
import { fingerprint, opaqueKey } from "./keys.js";
import { assertFact } from "../component/facts.js";
// Only admission refusals use this marker. Provider errors remain uncertain
// paid outcomes, even when their message happens to match an admission error.
class TaskDispatchRefused extends Error {
}
// Action-local capabilities are never serialized into Workflow arguments. Hook
// calls use the same receipts and cancellation fence as managed tool effects.
const bindings = new WeakMap();
/**
 * Bind a turn's attribution, key, usage slot and fence to its fenced action
 * context, so `runTask(hc.ctx, …)` inside a hook needs no options.
 */
export function bindTaskContext(ctx, binding) {
    bindings.set(ctx, binding);
}
/** Thin schema/prompt declaration. SDK Output.object owns parsing and validation
 * (ai/src/generate-text/output.ts:127-167); receipts only guard paid admission. */
export function defineTask(task) {
    if (!task.name ||
        task.name.length > LIMITS.requestKeyLength ||
        typeof task.prompt !== "function" ||
        (task.repair !== undefined && task.repair !== 0 && task.repair !== LIMITS.taskRepairs))
        throw new Error("INVALID_TASK");
    return { ...task };
}
/**
 * Run one structured task at most once per key.
 *
 * Returns the stored outcome for a repeated key, `running` while another call
 * holds the claim, `unknown` when a paid call's outcome cannot be known (it is
 * never retried), and `denied` for a key reused with a different payload or a
 * cancelled turn.
 */
export async function runTask(context, task, input, options = {}) {
    const call = await prepareTask(context, task, input, options);
    if (call.signal?.aborted)
        return { status: "denied", code: "CANCELLED" };
    const { attribution, binding, ctx, component } = call;
    const scope = `task:${await fingerprint([attribution.subject, attribution.threadId, task.name])}`;
    const receipt = { scope, key: call.key, ...binding?.fence };
    const admission = await beginTask(call, receipt);
    if (admission.status === "done" || admission.status === "failed")
        return admission.result;
    if (admission.status === "conflict")
        return { status: "denied", code: "KEY_CONFLICT" };
    if (admission.status === "stale")
        return { status: "denied", code: "CANCELLED" };
    if (admission.status !== "claimed")
        return { status: admission.status };
    const result = await generateWithRepair(call, receipt, admission);
    if (result.status === "unknown")
        return result;
    await ctx.runMutation(component.receipts.effects.complete, {
        ...receipt,
        claim: admission.claim,
        result,
        failed: result.status === "failed",
    });
    // complete refuses late claims. Read the same receipt admission back rather
    // than claiming a result that was discarded after lease expiry/cancellation.
    const committed = await beginTask(call, receipt);
    if (committed.status === "done" || committed.status === "failed")
        return committed.result;
    return committed.status === "stale"
        ? { status: "denied", code: "CANCELLED" }
        : { status: "unknown" };
}
/**
 * Resolve and validate one task call before any ledger write: context, key,
 * attribution facts, lease, model, parsed input and the rendered prompt.
 */
async function prepareTask(context, task, input, options) {
    const ctx = "ctx" in context ? context.ctx : context;
    const binding = bindings.get(ctx);
    const component = binding?.component ?? options.component;
    const attribution = binding?.attribution ?? options.attribution;
    if (!component || !attribution)
        throw new Error("TASK_CONTEXT_REQUIRED");
    const key = options.key ??
        (binding
            ? await opaqueKey("hook-task", attribution.runId, binding.turnKey, task.name)
            : undefined);
    if (!key || key.length > LIMITS.requestKeyLength)
        throw new Error("INVALID_TASK_KEY");
    for (const key of ["subject", "rootThreadId", "threadId", "runId", "agent"]) {
        assertFact(attribution[key], key, "INVALID_TASK_ATTRIBUTION");
    }
    const leaseMs = options.leaseMs ?? LIMITS.leaseMs;
    if (!Number.isSafeInteger(leaseMs) || leaseMs <= 0 || leaseMs > HOST_LIMITS.leaseMs.max)
        throw new Error("INVALID_TASK_LEASE");
    const model = options.model ?? task.model;
    if (!model)
        throw new Error("TASK_MODEL_REQUIRED");
    const maxPromptLength = options.maxPromptLength ?? LIMITS.taskPromptLength;
    const maxOutputTokens = options.maxOutputTokens ?? LIMITS.outputTokens;
    if (!Number.isSafeInteger(maxPromptLength) ||
        maxPromptLength < 1 ||
        maxPromptLength > TEXT_LIMITS.taskPromptCharacters ||
        !Number.isSafeInteger(maxOutputTokens) ||
        maxOutputTokens < 1 ||
        maxOutputTokens > LIMITS.outputTokens)
        throw new Error("INVALID_TASK_LIMITS");
    const parsed = await task.input.parseAsync(input);
    const prompt = task.prompt(parsed);
    if (!prompt.trim() || prompt.length > maxPromptLength)
        throw new Error("INVALID_TASK_PROMPT");
    const signal = "ctx" in context ? context.signal : options.signal;
    return {
        ctx,
        binding,
        component,
        attribution,
        task,
        options,
        key,
        leaseMs,
        model,
        parsed,
        prompt,
        signal,
    };
}
/**
 * Admit (or re-read) this task's receipt. The payload fingerprint covers the
 * parsed input, the prompt and the model, so a key reused for a different
 * payload is a conflict.
 */
async function beginTask(call, receipt) {
    const { model } = call;
    return call.ctx.runMutation(call.component.receipts.effects.begin, {
        ...receipt,
        fingerprint: await fingerprint([
            call.parsed,
            call.prompt,
            typeof model === "string" ? model : [model.provider, model.modelId],
        ]),
        leaseMs: call.leaseMs,
    });
}
/**
 * Generate the structured output under a claimed receipt, with at most
 * `task.repair` re-asks for invalid structured output.
 *
 * Returns `unknown` (after recording it in the ledger) when the claim expired
 * before an attempt or a call failed for any other reason; otherwise the
 * `done` / `failed` outcome to complete the receipt with.
 */
async function generateWithRepair(call, receipt, admission) {
    const { ctx, component, task, signal } = call;
    let result = { status: "failed", code: "TASK_FAILED" };
    try {
        let repairText;
        for (let attempt = 0; attempt <= (task.repair ?? LIMITS.taskRepairs); attempt++) {
            // Admission owns the authoritative deadline. A known invalid first answer
            // does not authorize another paid attempt after that claim has expired.
            if (Date.now() >= admission.leaseUntil) {
                await ctx.runMutation(component.receipts.effects.unknown, {
                    ...receipt,
                    claim: admission.claim,
                });
                return { status: "unknown" };
            }
            try {
                result = await generateOnce(call, receipt, attempt, repairText);
                break;
            }
            catch (error) {
                // Middleware has not entered doGenerate when admission refuses. There
                // is no paid attempt to meter or classify as an unknown receipt.
                if (error instanceof TaskDispatchRefused)
                    return { status: "failed", code: "TASK_FAILED" };
                if (!NoObjectGeneratedError.isInstance(error)) {
                    await recordTaskUsage(call, receipt, attempt, undefined, undefined);
                    throw error;
                }
                await recordTaskUsage(call, receipt, attempt, error.usage, undefined);
                result = { status: "failed", code: "INVALID_OUTPUT" };
                // Only invalid structured output permits one intentional re-ask. A
                // transport error/unknown paid outcome is never repaired or retried.
                if (error.text === undefined ||
                    error.text.length > LIMITS.taskPromptLength ||
                    signal?.aborted)
                    break;
                repairText = error.text;
            }
        }
    }
    catch {
        await ctx.runMutation(component.receipts.effects.unknown, {
            ...receipt,
            claim: admission.claim,
        });
        return { status: "unknown" };
    }
    return result;
}
/**
 * One paid structured-output call. Returns `done`, or `failed`/`INVALID_OUTPUT`
 * when the value would not fit a receipt; throws on invalid output or transport
 * errors (handled by `generateWithRepair`).
 */
async function generateOnce(call, receipt, attempt, repairText) {
    const generated = await abortTask(generateText({
        model: call.model,
        output: Output.object({ schema: call.task.output }),
        prompt: repairText === undefined
            ? call.prompt
            : `${call.prompt}\n\nYour previous response did not match the output schema. Return valid JSON matching the schema.\nPrevious response:\n${repairText}`,
        prepareStep: call.options.beforeDispatch
            ? ({ model }) => ({
                model: wrapLanguageModel({
                    // AI SDK generate-text.ts:590,907 passes the already resolved
                    // model to prepareStep; this preserves the host default provider.
                    model: model,
                    middleware: {
                        wrapGenerate: async ({ doGenerate }) => {
                            try {
                                await call.options.beforeDispatch();
                            }
                            catch {
                                throw new TaskDispatchRefused("TASK_DISPATCH_REFUSED");
                            }
                            return doGenerate();
                        },
                    },
                }),
            })
            : undefined,
        maxRetries: LIMITS.modelRetries,
        maxOutputTokens: call.options.maxOutputTokens ?? LIMITS.outputTokens,
        abortSignal: call.signal,
    }), call.signal);
    // Output validation can throw. Read it before recording so an invalid
    // answer is charged only by the repair/error path below.
    const value = generated.output;
    await recordTaskUsage(call, receipt, attempt, generated.usage, generated.providerMetadata, generated.response.id);
    // Convex validates the serializable result and its byte bound before
    // persistence. A huge response never becomes a >1 MiB receipt document.
    convexToJson(value);
    const result = { status: "done", value };
    if (getConvexSize(result) > LIMITS.receiptResultBytes)
        return { status: "failed", code: "INVALID_OUTPUT" };
    return result;
}
/** Meter one attempt under an opaque per-attempt key. Never triggers another call. */
async function recordTaskUsage(call, receipt, attempt, usage, providerMetadata, requestId) {
    const { model, attribution, binding, options, ctx } = call;
    try {
        const provider = typeof model === "string" ? model.split("/")[0] : model.provider;
        await (binding?.usage ?? options.usage)
            ?.scope(ctx, { ...attribution, model: typeof model === "string" ? model : model.modelId })
            .record(provider, {
            key: await opaqueKey("task-usage", receipt.scope, receipt.key, attempt),
            usage,
            providerMetadata,
            requestId,
        });
    }
    catch {
        /* Recording evidence must never trigger another paid call. */
    }
}
/** Bound waiting even when a provider ignores AbortSignal. The receipt records
 * the uncertain paid attempt once; a late answer cannot commit or buy a retry. */
function abortTask(work, signal) {
    if (!signal)
        return work;
    return new Promise((resolve, reject) => {
        const abort = () => reject(new Error("TASK_ABORTED"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted)
            abort();
        void work.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
    });
}
