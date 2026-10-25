import { tool } from 'ai';
import { z } from 'zod';

const todoSchema = z.object({
  id: z.string().min(1).max(100),
  text: z.string().min(1).max(4000),
  done: z.boolean(),
});
type Todo = z.infer<typeof todoSchema>;

/**
 * Demonstration only: creates one bounded, in-memory list per factory call.
 * Never share this instance between users. State is lost on process restart
 * and is not shared across server instances. Writes replace the whole list.
 * TODO: use the Agent component's storage, scoped to the trusted thread and
 * owner, per spec §8. Enforce host authorization before reads and writes.
 */
export function createTodoTools() {
  let todos: Todo[] = [];

  return {
    todo_read: tool({
      description: 'Read the demo todo list (at most 100 items).',
      inputSchema: z.object({}),
      execute: async () => ({ todos: structuredClone(todos) }),
    }),
    todo_write: tool({
      description: 'Replace the demo todo list (at most 100 items).',
      inputSchema: z.object({ todos: z.array(todoSchema).max(100) }),
      execute: async (input) => {
        todos = structuredClone(input.todos);
        return { todos: structuredClone(todos) };
      },
    }),
  };
}
