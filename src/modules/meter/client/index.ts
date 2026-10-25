/**
 * Public host exports for the optional agevex meter module.
 * Installing apps import providers, sinks, charge types and defineMeter here.
 * Implementation builders stay private to the module; the component itself
 * is mounted separately through agevex/meter/convex.config.
 */
export { defineMeter, inline, type Meter, type ThreadCost } from "./client.js";
export { BreakdownDisabledError, type Breakdown } from "../shared/breakdowns.js";
export { openRouterCost, observeProviderOutcome, usageHandlerFor } from "./helpers.js";
export { polarSink, webhookSink, SinkDeliveryError } from "./sinks.js";
export { LIMITS, type ResolvedLimits as MeterLimits } from "../shared/limits.js";
export type {
  ActionCtx,
  Attribution,
  Charge,
  ChargeHandle,
  Cost,
  MeterOptions,
  Provider,
  ReadCtx,
  ScopedMeter,
  Sink,
  SinkEvent,
  UnknownReason,
  WriteCtx,
} from "./types.js";
export type { ComponentApi } from "../component/_generated/component.js";
