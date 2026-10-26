// Bound the provider separately from tool execution. AI SDK stepMs includes
// tools (ai/src/prompt/request-options.ts:7), so it cannot express this policy.
// Native Agent 0.7.7 index.ts:545-579 / client/streamText.ts:213 pass prepareStep
// through to AI SDK, preserving native saves and exact usage/approval ids.
import { gateway, wrapLanguageModel } from "ai";
import { RUN_LIMITS } from "../../component/run_settings.js";
import { providerEvidence } from "./provider-evidence.js";
/** Provider-only deadline, covering the entire stream, and a tool-call cap. */
export function boundedModel(gen, model) {
    const { fence, turn } = gen;
    const timeoutMs = turn.claimed.settings.modelTimeoutMs;
    return wrapLanguageModel({
        model: typeof model === "string" ? gateway(model) : model,
        middleware: {
            wrapGenerate: async ({ doGenerate }) => {
                gen.state.modelStarted = true;
                const stop = fence.deadline(timeoutMs);
                try {
                    const result = await fence.wait(doGenerate());
                    if (result.content.filter((part) => part.type === "tool-call").length >
                        RUN_LIMITS.toolsPerSlice)
                        throw new Error("TOOL_CALL_LIMIT");
                    return {
                        ...result,
                        providerMetadata: providerEvidence(result.providerMetadata, result.response?.id),
                    };
                }
                finally {
                    stop();
                }
            },
            wrapStream: async ({ doStream }) => {
                gen.state.modelStarted = true;
                const stop = fence.deadline(timeoutMs);
                const result = await fence.wait(doStream());
                let calls = 0;
                let requestId;
                return {
                    ...result,
                    stream: result.stream.pipeThrough(new TransformStream({
                        transform(part, controller) {
                            if (part.type === "response-metadata" && part.id)
                                requestId = part.id;
                            if (part.type === "finish")
                                part = {
                                    ...part,
                                    providerMetadata: providerEvidence(part.providerMetadata, requestId),
                                };
                            if (part.type === "tool-call" && ++calls > RUN_LIMITS.toolsPerSlice) {
                                fence.controller.abort(new Error("TOOL_CALL_LIMIT"));
                                throw new Error("TOOL_CALL_LIMIT");
                            }
                            if (part.type === "finish" || part.type === "error")
                                stop();
                            controller.enqueue(part);
                        },
                        flush: stop,
                    })),
                };
            },
        },
    });
}
/** Bound every local invocation, including collaboration and resumed approvals.
 * AI SDK's supported toolCallConcurrency:1 serializes these wrappers. A timeout
 * aborts the whole slice, leaving paid receipts unknown instead of retryable.
 */
export function boundToolDeadlines(gen, tools, budget) {
    for (const [name, declared] of Object.entries(tools)) {
        if (!declared.execute)
            continue;
        const execute = declared.execute;
        tools[name] = {
            ...declared,
            execute: async function (input, options) {
                await gen.fence.assertActive();
                await budget();
                // Only newly emitted model calls count toward the cap above. Native
                // approval resumes execute before that step and must not consume it.
                const stop = gen.fence.deadline(gen.turn.claimed.settings.toolTimeoutMs);
                try {
                    const output = await gen.fence.wait(execute.call(this, input, {
                        ...options,
                        abortSignal: gen.fence.controller.signal,
                    }));
                    if (output && typeof output === "object" && Symbol.asyncIterator in output)
                        return boundedToolStream(gen, output, stop);
                    stop();
                    return output;
                }
                catch (error) {
                    stop();
                    throw error;
                }
            },
        };
    }
    return tools;
}
/** Keep the deadline alive through an async tool's last yielded result. */
async function* boundedToolStream(gen, output, stop) {
    const iterator = output[Symbol.asyncIterator]();
    try {
        while (true) {
            const next = await gen.fence.wait(Promise.resolve(iterator.next()));
            if (next.done)
                return;
            yield next.value;
        }
    }
    finally {
        stop();
    }
}
