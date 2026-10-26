import type { Event, IntegrationContext } from "./types.js";
/** Open a tool beneath its model/step using the step ordinal, preserving stable ancestry. */
export declare function onToolExecutionStart(context: IntegrationContext, event: Event<"onToolExecutionStart">): void;
/** Finish the matching tool and record only permitted successful output before forgetting it. */
export declare function onToolExecutionEnd(context: IntegrationContext, event: Event<"onToolExecutionEnd">): void;
