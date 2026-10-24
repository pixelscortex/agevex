import { defineSchema } from "convex/server";
import { todoTables } from "../../../docs/site/registry/todo/todoSchema.js";
import { goalTables } from "../../../docs/site/registry/goals/goalsSchema.js";

// Mount the actual shipped snippets, rather than recreating their schema.
export default defineSchema({ ...todoTables, ...goalTables });
