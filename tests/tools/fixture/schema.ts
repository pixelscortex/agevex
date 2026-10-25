import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { todoTables } from "../../../src/modules/tools/registry/todo/todoSchema.js";
import { goalTables } from "../../../src/modules/tools/registry/goals/goalsSchema.js";
import { consentTables } from "../../../src/modules/tools/registry/continue-budget/continueBudgetSchema.js";

// Mount the actual shipped snippets, rather than recreating their schema.
export default defineSchema({
  ...todoTables,
  ...goalTables,
  ...consentTables,
  // The fake host's budget policy. A real host owns its own policy storage;
  // keeping it in the database lets tests prove the raise commits (or rolls
  // back) in the same transaction as the cancel and the fresh send.
  budgets: defineTable({ subject: v.string(), limit: v.number() }).index("by_subject", ["subject"]),
});
