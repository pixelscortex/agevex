import { defineOnceTool } from "agevex";
import type { FunctionReference } from "convex/server";
import { z } from "zod";

export const TODO_LIMITS = {
  minChars: 1,
  items: 100,
  idChars: 100,
  textChars: 4000,
  listBytes: 32 * 1024,
  scopeChars: 1024,
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

export const todoScope = z.strictObject({
  subject: z.string().min(TODO_LIMITS.minChars).max(TODO_LIMITS.scopeChars),
  threadId: z.string().min(TODO_LIMITS.minChars).max(TODO_LIMITS.scopeChars),
});

type Scope = z.infer<typeof todoScope>;
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
        return tc.ctx.runQuery(
          refs.read,
          todoScope.parse({ subject: tc.subject, threadId: tc.threadId }),
        );
      },
    }),
    todo_write: defineOnceTool({
      name: "todo_write",
      input: z.strictObject({ todos: todoList }),
      run: async (input, tc) => {
        tc.signal.throwIfAborted();
        const { todos } = z.strictObject({ todos: todoList }).parse(input);
        // Never take an owner or thread from model input. The managed context
        // routes this internal mutation through core's atomic cancellation fence.
        const scope = todoScope.parse({ subject: tc.subject, threadId: tc.threadId });
        return tc.ctx.runMutation(refs.write, { ...scope, todos });
      },
    }),
  };
  tools.todo_read.description =
    "Read this owner's durable thread todo list. Use a new call id for a fresh read.";
  tools.todo_write.description = `Replace this owner's thread todo list with up to ${TODO_LIMITS.items} unique items. The entire serialized UTF-8 list must fit ${TODO_LIMITS.listBytes} bytes. An empty list clears it.`;
  return tools;
}
