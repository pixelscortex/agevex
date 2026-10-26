/**
 * Stable component API registrations for the meter charge lifecycle.
 * Host client calls and Workpool callbacks keep their original charges paths.
 * Wire validators live in charge-contracts; concept handlers own the same
 * transactional reads/writes, fences and bounds behind these entry points.
 */
import { v } from "convex/values";
import { query, mutation, internalMutation } from "./_generated/server.js";
import { find, outcome } from "./charge-records.js";
import { createCharge } from "./charge-creation.js";
import { updateCharge } from "./charge-updates.js";
import { attachCharge, expireCharge, recordLookupResult } from "./charge-lookup.js";
import {
  claimDeliveryBatch,
  recordDeliveryResult,
  completeDelivery,
  retryPendingSinks,
} from "./delivery.js";
import { pruneCharges } from "./retention.js";
import {
  createArgs,
  updateArgs,
  attachArgs,
  expireArgs,
  lookupResultArgs,
  claimDeliveriesArgs,
  deliveryResultArgs,
  deliveryCompleteArgs,
  retrySinksArgs,
  pruneArgs,
} from "./charge-contracts.js";

/** Return one charge with bounded delivery state; callers authorize in the host client. */
export const get = query({
  args: { key: v.string() },
  handler: async (ctx, { key }) => {
    const row = await find(ctx, key);

    return row && (await outcome(ctx, row));
  },
});

/** Admit or replay an immutable charge key and update its aggregate/outbox state. */
export const create = mutation({
  args: createArgs,
  handler: createCharge,
});

/** Apply one idempotent correction or authoritative settlement. */
export const update = mutation({
  args: updateArgs,
  handler: updateCharge,
});

/** Attach provider evidence identity and schedule its bounded lookup window. */
export const attach = mutation({
  args: attachArgs,
  handler: attachCharge,
});

/** One-shot deadline for unresolved lookup evidence. */
export const expire = internalMutation({
  args: expireArgs,
  handler: expireCharge,
});

/** Fence read-only lookup callbacks and retain authoritative billing evidence. */
export const lookupResult = mutation({
  args: lookupResultArgs,
  handler: recordLookupResult,
});

/** Claim one bounded sink batch without reading large charge documents. */
export const claimDeliveries = mutation({
  args: claimDeliveriesArgs,
  handler: claimDeliveryBatch,
});

/** Acknowledge a bounded claimed batch or record its failed attempt. */
export const deliveryResult = mutation({
  args: deliveryResultArgs,
  handler: recordDeliveryResult,
});

/** Workpool completion fence for delivery crashes and claim cleanup. */
export const deliveryComplete = internalMutation({
  args: deliveryCompleteArgs,
  handler: completeDelivery,
});

/** Explicitly retry pending sink events without stealing in-flight claims. */
export const retrySinks = mutation({
  args: retrySinksArgs,
  handler: retryPendingSinks,
});

/** Prune terminal charges under conservative transaction budgets. */
export const prune = mutation({
  args: pruneArgs,
  handler: pruneCharges,
});
