/** Public tool-free background text policy and registration-time hard bounds. */
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { LanguageModel } from "ai";
import { createFunctionHandle } from "convex/server";
import type { Registration, ManagedAgent } from "../types.js";
import { LIMITS } from "../../component/limits.js";
import { TEXT_LIMITS } from "../../component/text/values.js";

export type TextTaskOptions = {
  model?: Extract<LanguageModel, string | LanguageModelV4>;
  prompt?: string;
  /** Output cap for this call. Defaults to 128 for titles and 2048 for summaries;
   * must be a positive integer within the task bound (`LIMITS.outputTokens`, 4096). */
  maxOutputTokens?: number;
};
export type ThreadTextOptions = {
  /** On by default, once after the first user message. User renames always win. */
  title?: false | TextTaskOptions;
  /** Opt in for on-demand summaries; call summarize from your own cadence hook. */
  summary?: false | TextTaskOptions;
};
export type TextTaskArgs = { assignmentId: string; kind: "title" | "summary"; key: string };

/** Fail before request acceptance when the host cannot dispatch metadata work. */
export function assertTextOptions(config: Registration) {
  if ((config.title !== false || config.summary) && typeof config.refs.textTask !== "function")
    throw new Error("TEXT_TASK_REF_REQUIRED");

  for (const options of [config.title, config.summary]) {
    if (options === undefined || options === false) continue;

    if (
      !options ||
      typeof options !== "object" ||
      (options.prompt !== undefined &&
        (typeof options.prompt !== "string" ||
          !options.prompt.trim() ||
          options.prompt.length > TEXT_LIMITS.promptCharacters)) ||
      (options.maxOutputTokens !== undefined &&
        (!Number.isSafeInteger(options.maxOutputTokens) ||
          options.maxOutputTokens < 1 ||
          options.maxOutputTokens > LIMITS.outputTokens))
    )
      throw new Error("INVALID_TEXT_OPTIONS");
  }

  const summary = config.summary;

  for (const agent of config.agents)
    if (
      ((config.title !== false && !config.title?.model) || (summary && !summary.model)) &&
      !agent.textModel
    )
      throw new Error("TEXT_TASK_MODEL_REQUIRED");
}

/** Native update handle crosses the component boundary so automatic title and
 * text commit in one mutation (Agent client/threads.ts:55-64). */
export async function persistedTextConfig(config: Registration, native: ManagedAgent) {
  if (config.title === false && !config.summary) return undefined;

  return {
    worker: await createFunctionHandle(config.refs.textTask!()),
    updateThread: await createFunctionHandle(native.component.threads.updateThread),
    getThread: await createFunctionHandle(native.component.threads.getThread),
    title: config.title !== false,
    summary: !!config.summary,
  };
}
