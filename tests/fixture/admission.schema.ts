// Host-owned state used to prove admit shares the accepting mutation's transaction.
// Native Agent and agevex still own all transcript and coordination tables.
import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";

export default defineSchema({
  admissionProbes: defineTable({ accepted: v.number() }),
});
