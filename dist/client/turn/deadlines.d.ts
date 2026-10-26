import { type LanguageModel, type ToolSet } from "ai";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import type { Generation } from "./context.js";
/** Provider-only deadline, covering the entire stream, and a tool-call cap. */
export declare function boundedModel(gen: Generation, model: LanguageModel): LanguageModelV4;
/** Bound every local invocation, including collaboration and resumed approvals.
 * AI SDK's supported toolCallConcurrency:1 serializes these wrappers. A timeout
 * aborts the whole slice, leaving paid receipts unknown instead of retryable.
 */
export declare function boundToolDeadlines(gen: Generation, tools: ToolSet, budget: () => Promise<void>): ToolSet;
