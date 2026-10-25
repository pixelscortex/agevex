// Host-side module API and helpers; this code is imported by the installing app.
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
