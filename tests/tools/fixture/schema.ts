import { defineSchema, defineTable } from "convex/server";
import { v } from "convex/values";
import { todoTables } from "../../../docs/site/registry/todo/todoSchema.js";
import { goalTables } from "../../../docs/site/registry/goals/goalsSchema.js";
import { consentTables } from "../../../docs/site/registry/continue-budget/continueBudgetSchema.js";

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
