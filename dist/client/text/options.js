import { createFunctionHandle } from "convex/server";
import { LIMITS } from "../../component/limits.js";
import { TEXT_LIMITS } from "../../component/text/values.js";
/** Fail before request acceptance when the host cannot dispatch metadata work. */
export function assertTextOptions(config) {
    if ((config.title !== false || config.summary) && typeof config.refs.textTask !== "function")
        throw new Error("TEXT_TASK_REF_REQUIRED");
    for (const options of [config.title, config.summary]) {
        if (options === undefined || options === false)
            continue;
        if (!options ||
            typeof options !== "object" ||
            (options.prompt !== undefined &&
                (typeof options.prompt !== "string" ||
                    !options.prompt.trim() ||
                    options.prompt.length > TEXT_LIMITS.promptCharacters)) ||
            (options.maxOutputTokens !== undefined &&
                (!Number.isSafeInteger(options.maxOutputTokens) ||
                    options.maxOutputTokens < 1 ||
                    options.maxOutputTokens > LIMITS.outputTokens)))
            throw new Error("INVALID_TEXT_OPTIONS");
    }
    const summary = config.summary;
    if (summary &&
        summary.everyTurns !== undefined &&
        (!Number.isSafeInteger(summary.everyTurns) ||
            summary.everyTurns < 1 ||
            summary.everyTurns > TEXT_LIMITS.everyTurns))
        throw new Error("INVALID_TEXT_OPTIONS");
    for (const agent of config.agents)
        if (((config.title !== false && !config.title?.model) || (summary && !summary.model)) &&
            !agent.textModel)
            throw new Error("TEXT_TASK_MODEL_REQUIRED");
}
/** Native update handle crosses the component boundary so automatic title and
 * version/source commit in one mutation (Agent client/threads.ts:55-64). */
export async function persistedTextConfig(config, native) {
    if (config.title === false && !config.summary)
        return undefined;
    return {
        worker: await createFunctionHandle(config.refs.textTask()),
        updateThread: await createFunctionHandle(native.component.threads.updateThread),
        getThread: await createFunctionHandle(native.component.threads.getThread),
        title: config.title !== false,
        summary: !!config.summary,
        everyTurns: config.summary ? config.summary.everyTurns : undefined,
    };
}
