import { defineOnceTool } from "agevex";
import type { FunctionReference } from "convex/server";
import { z } from "zod";

export const TODO_LIMITS = {
  minChars: 1,
  items: 100,
  idChars: 100,
  textChars: 4000,
  listBytes: 32 * 1024,
  cleanupBatch: 128,
} as const;

export const todoList = z
  .array(
    z.strictObject({
      id: z.string().min(TODO_LIMITS.minChars).max(TODO_LIMITS.idChars),
      text: z.string().min(TODO_LIMITS.minChars).max(TODO_LIMITS.textChars),
      done: z.boolean(),
    }),
  )
  .max(TODO_LIMITS.items)
  .superRefine((todos, ctx) => {
    if (new Set(todos.map(({ id }) => id)).size !== todos.length)
      ctx.addIssue({ code: "custom", message: "Todo ids must be unique" });
    // A count bound alone allows 100 × 4000 four-byte characters (>1 MiB).
    // Bound serialized UTF-8 as well: the list and its ledger result stay small.
    if (new TextEncoder().encode(JSON.stringify(todos)).byteLength > TODO_LIMITS.listBytes)
      ctx.addIssue({ code: "custom", message: "Todo list exceeds 32 KiB" });
  });

// Core validates every ToolContext fact (nonempty, at most LIMITS.factBytes
// UTF-8 bytes) before a tool runs, so the scope is passed through unchanged.
type Scope = { subject: string; threadId: string };
type Result = { todos: z.infer<typeof todoList> };
export type TodoFunctions = {
  read: FunctionReference<"query", "internal", Scope, Result>;
  write: FunctionReference<"mutation", "internal", Scope & Result, Result>;
};

/** Register on an agevex Agent; the runtime supplies the fenced ToolContext. */
export function createTodoTools(refs: TodoFunctions) {
  const tools = {
    todo_read: defineOnceTool({
      name: "todo_read",
      input: z.strictObject({}),
      run: async (_input, tc) => {
        tc.signal.throwIfAborted();
        return tc.ctx.runQuery(refs.read, { subject: tc.subject, threadId: tc.threadId });
      },
    }),
    todo_write: defineOnceTool({
      name: "todo_write",
      input: z.strictObject({ todos: todoList }),
      run: async (input, tc) => {
        tc.signal.throwIfAborted();
        // AI SDK already validated `input` against the strict schema above, so
        // ownership can never come from the model. The managed context routes
        // this internal mutation through core's atomic cancellation fence.
        return tc.ctx.runMutation(refs.write, {
          subject: tc.subject,
          threadId: tc.threadId,
          todos: input.todos,
        });
      },
    }),
  };
  tools.todo_read.description =
    "Read this owner's durable thread todo list. Use a new call id for a fresh read.";
  tools.todo_write.description = `Replace this owner's thread todo list with up to ${TODO_LIMITS.items} unique items. The entire serialized UTF-8 list must fit ${TODO_LIMITS.listBytes} bytes. An empty list clears it.`;
  return tools;
}
