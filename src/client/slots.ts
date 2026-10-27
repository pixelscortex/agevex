/** Stateless host contracts. Apps own usage ledgers and budget policy; core
 * contains no pricing, reconciliation workers or billing tables. */
import type { GenericActionCtx, GenericDataModel } from "convex/server";
import type { Telemetry, ToolSet } from "ai";
import type { ToolContext } from "./once.js";

/** All semantic facts are nonempty and at most LIMITS.factBytes (128 UTF-8 bytes).
 * Opaque keys are full SHA-256 hex (64 bytes); original facts stay in attribution.
 * Server-derived attribution. Optional modules depend on this contract; core
 * never depends on their components, provider clients or storage formats. */
export type SlotFacts = {
  subject: string;
  rootThreadId: string;
  threadId: string;
  runId: string;
  agent: string;
  purpose?: "agent" | "hook" | "tool" | "title";
  /** Delegation identity; absent on the root node. Never supplied by the model. */
  nodeId?: string;
};
export type UsageView = {
  inputTokens: number | null;
  outputTokens: number | null;
  estimatedUsd: number;
  settledUsd: number;
  unknown: number;
  reporting: "available" | "partial";
};
export type UsageViewArgs = {
  subject: string;
  runId: string;
  /** At most 51 exclusive nodes, already discovered by the caller; null is root. */
  nodeIds: (string | null)[];
  partial?: boolean;
};
export type UsageProjection = {
  total: UsageView;
  nodes: { nodeId: string | null; usage: UsageView }[];
};
export type SlotReadCtx = Pick<SlotActionCtx, "runQuery" | "auth">;
export type SlotActionCtx = GenericActionCtx<GenericDataModel>;
/** One native step or standalone task; apps dedupe by key in their own ledger.
 * Standalone tasks/titles and steps whose native save was dropped have null messageId. */
export type UsageEvent = SlotFacts & {
  key: string;
  status: "success" | "failed" | "aborted";
  /** Provider step completion time, epoch milliseconds (not delivery time). */
  occurredAt: number;
  model?: string;
  provider?: string;
  usage: unknown;
  providerMetadata?: unknown;
  requestId?: string;
  messageId: string | null;
};
export type UsageSlot = {
  /** Managed turns retry throwing hooks with the same event/key. Deduplicate
   * transactionally: a hook may have committed before its caller stopped waiting. */
  record(ctx: SlotActionCtx, event: UsageEvent): Promise<void>;
  /** Optional app-owned projection; absent adapters leave run-tree usage null. */
  view?(ctx: SlotReadCtx, args: UsageViewArgs): Promise<UsageProjection>;
};
export type BudgetSlot = {
  check(
    ctx: SlotActionCtx,
    args: { subject: string; runId: string },
  ): Promise<{ allowed: boolean }>;
};
export type TelemetrySlot = {
  integration(facts: SlotFacts & { turnKey: string }): Telemetry;
  flush(facts: SlotFacts & { turnKey: string }, signal?: AbortSignal): Promise<void>;
};
export type SandboxSlot = {
  tools(context: ToolContext): ToolSet;
};
