import type { GenericActionCtx, GenericDataModel, FunctionReference } from "convex/server";
import type { Doc } from "./component/_generated/dataModel.js";
import type { ResolvedLimits } from "./limits.js";
import type { Breakdown } from "./breakdowns.js";

export type ReadCtx = Pick<GenericActionCtx<GenericDataModel>, "runQuery" | "auth">;
export type WriteCtx = Pick<
  GenericActionCtx<GenericDataModel>,
  "runQuery" | "runMutation" | "auth"
>;
export type ActionCtx = GenericActionCtx<GenericDataModel>;
export type Attribution = Doc<"charges">["attribution"];
export type Charge = Omit<Doc<"charges">, "_id" | "operations"> & { _id: string };
export type Cost = { usd: number } | { credits: number };
export type Provider = {
  inline?: (args: { usage: unknown; providerMetadata: unknown }) => Cost | undefined;
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
  attribution: Attribution;
  provider: string;
};
export type Sink = { name?: string; deliver: (batch: SinkEvent[]) => Promise<void> };
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
  /** Stable keys are required today; agent tools will default to tc.toolCallId once core wiring lands. */
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
    args: { key: string; usage?: unknown; providerMetadata?: unknown },
  ): Promise<ChargeHandle>;
};
