/**
 * Public host exports for the optional agevex meter module.
 * Installing apps import providers, sinks, charge types and defineMeter here.
 * Implementation builders stay private to the module; the component itself
 * is mounted separately through agevex/meter/convex.config.
 */
export { defineMeter, inline } from "./client.js";
export { BreakdownDisabledError } from "../shared/breakdowns.js";
export { openRouterCost, observeProviderOutcome, usageHandlerFor } from "./helpers.js";
export { polarSink, webhookSink, SinkDeliveryError } from "./sinks.js";
export { LIMITS } from "../shared/limits.js";
