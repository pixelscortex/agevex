/**
 * Adapters from core usage and budget slots to the standalone meter operations.
 * Core supplies trusted attribution and stable receipt keys; these adapters
 * preserve those identities and hash only oversized model labels.
 * Budget checks remain snapshots and propagate errors so core fails closed.
 */
import type { BudgetSlot, UsageSlot } from "../../../client/slots.js";
import { type MeterContext } from "./configuration.js";
import type { MeterOptions } from "./types.js";
/**
 * Core passes the Agent's stored `message.provider`, the AI SDK provider id
 * (`@openrouter/ai-sdk-provider` 3.1.0 stores "openrouter.chat"). Resolve an
 * exact registered name first, then an explicit mapping, then the LONGEST
 * registered dotted prefix ("google.vertex.chat" -> "google.vertex" before
 * "google"). Anything else stays as given and records unknown.
 */
export declare function resolver(meter: MeterContext, mapping?: Record<string, string>): (name: string) => string;
/** Bind core's server-derived attribution to the existing component API.
 * Core already hashes charge AND lifecycle operation keys. Passing them
 * through unchanged keeps saved model steps and tool replays on the same
 * idempotent charge/operation receipts; another usage handler would bill
 * the same saved step a second time under a different identity. */
export declare function usageSlot(meter: MeterContext, slot?: {
    providers?: Record<string, string>;
}): UsageSlot;
/** Use the same run-scoped aggregate check as the standalone API. A slot
 * policy overrides only the cap, leaving recording and read policy intact.
 * Fail closed: estimates count, unknown costs deny even without a cap, and
 * authorization/read/policy errors propagate to core, which ends the slice
 * with BUDGET_EXCEEDED rather than admitting potentially unbounded spend.
 * This remains a snapshot check, not a reservation for concurrent work. */
export declare function budgetSlot(meter: MeterContext, policy?: MeterOptions["budgets"]): BudgetSlot;
