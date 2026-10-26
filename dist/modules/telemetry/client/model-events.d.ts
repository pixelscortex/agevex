import type { Event, IntegrationContext } from "./types.js";
/** Open the next model attempt beneath its step and record only permitted input. */
export declare function onLanguageModelCallStart(context: IntegrationContext, event: Event<"onLanguageModelCallStart">): void;
/** Close a completed model attempt and propagate safe failure status to its ancestors. */
export declare function onLanguageModelCallEnd(context: IntegrationContext, event: Event<"onLanguageModelCallEnd">): void;
