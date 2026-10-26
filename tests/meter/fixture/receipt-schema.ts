/** Host-owned sink receipts prove delivery runs outside the meter component. */
import { defineSchema, defineTable } from "convex/server";
import { event } from "../../../src/modules/meter/component/schema.js";

export default defineSchema({
  sinkReceipts: defineTable(event).index("by_external_id", ["externalId"]),
});
