import type { Event, IntegrationContext } from "./types.js";
/** Open supported SDK calls using the shared turn ordinal, then attach opt-in input. */
export declare function onStart(context: IntegrationContext, event: Event<"onStart">): void;
/** Reset per-step attempts and tool ordinals when SDK opens the next step. */
export declare function onStepStart(context: IntegrationContext, event: Event<"onStepStart">): void;
/** Close a step while distinguishing a ceiling-dropped chat from an incomplete stream. */
export declare function onStepEnd(context: IntegrationContext, event: Event<"onStepEnd">): void;
/** Record final usage/output and close the call without promoting unfinished children to success. */
export declare function onEnd(context: IntegrationContext, event: Event<"onEnd">): void;
/** Close the aborted SDK call with a safe reason; never export the raw abort diagnostic. */
export declare function onAbort(context: IntegrationContext, event: Event<"onAbort">): void;
/** Close only the identified failed call; arbitrary SDK error content remains private. */
export declare function onError(context: IntegrationContext, event: Event<"onError">): void;
