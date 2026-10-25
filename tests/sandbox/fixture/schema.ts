import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
export default defineSchema({ events: defineTable({ value: v.any() }) });
