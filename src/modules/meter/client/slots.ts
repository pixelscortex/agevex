/**
 * Adapters from core usage and budget slots to the standalone meter operations.
 * Core supplies trusted attribution and stable receipt keys; these adapters
 * preserve those identities and hash only oversized model labels.
 * Budget checks remain snapshots and propagate errors so core fails closed.
 */
import type { BudgetSlot, UsageSlot } from "../../../client/slots.js";
import { LIMITS, text } from "../shared/limits.js";
import { registered, type MeterContext } from "./configuration.js";
import { hashLabel } from "./helpers.js";
import { bind } from "./scope.js";
import { check } from "./reads.js";
import type { MeterOptions } from "./types.js";

/**
 * Core passes the Agent's stored `message.provider`, the AI SDK provider id
 * (`@openrouter/ai-sdk-provider` 3.1.0 stores "openrouter.chat"). Resolve an
 * exact registered name first, then an explicit mapping, then the LONGEST
 * registered dotted prefix ("google.vertex.chat" -> "google.vertex" before
 * "google"). Anything else stays as given and records unknown.
 */
export function resolver(meter: MeterContext, mapping: Record<string, string> = {}) {
  for (const [id, name] of Object.entries(mapping)) {
    text(id, "PROVIDER");

    if (!registered(meter, name)) throw new Error("PROVIDER_NOT_REGISTERED");
  }

  return (name: string) => {
    if (registered(meter, name)) return name;

    if (Object.prototype.hasOwnProperty.call(mapping, name)) return mapping[name];

    const parts = name.split(".");

    for (let length = parts.length - 1; length > 0; length--) {
      const prefix = parts.slice(0, length).join(".");

      if (prefix && registered(meter, prefix)) return prefix;
    }

    return name;
  };
}

/** Bind core's server-derived attribution to the existing component API.
 * Core already hashes charge AND lifecycle operation keys. Passing them
 * through unchanged keeps saved model steps and tool replays on the same
 * idempotent charge/operation receipts; another usage handler would bill
 * the same saved step a second time under a different identity. */
export function usageSlot(
  meter: MeterContext,
  slot: { providers?: Record<string, string> } = {},
): UsageSlot {
  const resolve = resolver(meter, slot.providers);

  return {
    // A model id over the label limit would fail validation and, since core
    // swallows meter errors, drop the charge. Store `sha256:<hex>` instead
    // (71 bytes); the full id is never stored.
    scope: (ctx, facts) =>
      bind(
        meter,
        ctx,
        async () =>
          facts.model !== undefined &&
          new TextEncoder().encode(facts.model).length > LIMITS.maxStringBytes
            ? { ...facts, model: `sha256:${await hashLabel(facts.model)}` }
            : facts,
        true,
        resolve,
      ),
  };
}
/** Use the same run-scoped aggregate check as the standalone API. A slot
 * policy overrides only the cap, leaving recording and read policy intact.
 * Fail closed: estimates count, unknown costs deny even without a cap, and
 * authorization/read/policy errors propagate to core, which ends the slice
 * with BUDGET_EXCEEDED rather than admitting potentially unbounded spend.
 * This remains a snapshot check, not a reservation for concurrent work. */
export function budgetSlot(
  meter: MeterContext,
  policy: MeterOptions["budgets"] = meter.options.budgets,
): BudgetSlot {
  return {
    // Trusted like usageSlot: core's slice gate runs without user identity.
    check: async (ctx, args) => ({
      allowed: (await check(meter, ctx, args, policy, true)).allowed,
    }),
  };
}
