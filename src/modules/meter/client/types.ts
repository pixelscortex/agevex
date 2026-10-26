/**
 * Host contracts for provider pricing, scoped charges, sinks and registration.
 * Charge shapes follow the component schema while hiding its operation ledger.
 * Contexts expose only the capabilities needed by host operations; providers
 * and sink adapters run in host actions, outside component transactions.
 */
import type { GenericActionCtx, GenericDataModel, FunctionReference } from "convex/server";
import type { Infer } from "convex/values";
import type { Doc } from "../component/_generated/dataModel.js";
import type { reason, sinkView } from "../component/schema.js";
import type { ResolvedLimits } from "../shared/limits.js";
import type { Breakdown } from "../shared/breakdowns.js";

export type ReadCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "auth">;
export type WriteCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "auth"
>;
export type ActionCtx = GenericActionCtx<GenericDataModel>;
export type Attribution = Doc<"charges">["attribution"];
/** Why a charge was created `unknown` (kept after a later settlement). */
export type UnknownReason = Infer<typeof reason>;
export type Charge = Omit<Doc<"charges">, "_id" | "operations" | "terminal" | "sinkState"> & {
  _id: string;
  /** Delivery state per sink; `attempts`/`failed` describe the pending event. */
  sinkState: Infer<typeof sinkView>;
};
export type Cost = { usd: number } | { credits: number };
export type Provider = {
  inline?: (args: { usage: unknown; providerMetadata: unknown }) => Cost | undefined;
  /** Used only when inline evidence is missing; return undefined for unpriced models. */
  estimate?: (args: { usage: unknown; model?: string }) => Cost | undefined;
  profiles?: Record<string, { unit: string; usd: number }>;
  credits?: { usdPerCredit: number };
  lookup?: (ctx: ActionCtx, requestId: string) => Promise<Cost | undefined>;
  /** Milliseconds, or the explicit convenience strings used in the spec. */
  lookupFor?: number | "1h" | "1d";
};
export type SinkEvent = {
  externalId: string;
  key: string;
  nanos: number;
  totalNanos: number;
  revision: number;
  /** Immutable classification captured when this revision enters the outbox. */
  status: Charge["status"];
  source: Charge["source"];
  attribution: Attribution;
  provider: string;
};
export type Sink = {
  name?: string;
  /** Include known initial estimates; frozen per charge at creation, without backfill. */
  estimates?: boolean;
  /** The delivery worker's host action context, including host internal mutations. */
  deliver: (batch: SinkEvent[], ctx: ActionCtx) => Promise<void>;
};
export type MeterOptions = {
  providers: Record<string, Provider>;
  /** Opt-in projections for new charges; enabling later does not backfill older charges. */
  breakdowns?: Breakdown[];
  sinks?: Sink[];
  budgets?: (scope: {
    subject: string;
    runId?: string;
  }) => { maxUsd: number } | Promise<{ maxUsd: number }>;
  limits?: Partial<ResolvedLimits>;
  workers?: {
    lookup?: FunctionReference<"action", "internal">;
    deliver?: FunctionReference<"action", "internal">;
  };
  /** Optional server-side guard; browser-facing wrappers must use host authorization. */
  authorize?: (ctx: ReadCtx, scope: Partial<Attribution>) => Promise<void>;
};

export type ChargeHandle = {
  key: string;
  /** Standalone calls supply stable keys; the usage slot passes core's hashed operation keys. */
  attach(args: { requestId: string; key: string }): Promise<Charge>;
  /** Reuse a stable operation key on replay; keys are shared across all three methods. */
  correct(args: { quantity: number; key: string }): Promise<Charge>;
  settle(args: Cost & { key: string }): Promise<Charge>;
  get(): Promise<Charge | null>;
};
export type ScopedMeter = {
  estimate(
    provider: string,
    args: { key: string; profile?: string; quantity: number },
  ): Promise<ChargeHandle>;
  record(
    provider: string,
    args: { key: string; usage?: unknown; providerMetadata?: unknown; requestId?: string },
  ): Promise<ChargeHandle>;
};
