import type { FunctionReference } from "convex/server";
import { z } from "zod";
export declare const TODO_LIMITS: {
    readonly minChars: 1;
    readonly items: 100;
    readonly idChars: 100;
    readonly textChars: 4000;
    readonly listBytes: number;
    readonly cleanupBatch: 128;
};
export declare const todoList: z.ZodArray<z.ZodObject<{
    id: z.ZodString;
    text: z.ZodString;
    done: z.ZodBoolean;
}, z.core.$strict>>;
type Scope = {
    subject: string;
    threadId: string;
};
type Result = {
    todos: z.infer<typeof todoList>;
};
export type TodoFunctions = {
    read: FunctionReference<"query", "internal", Scope, Result>;
    write: FunctionReference<"mutation", "internal", Scope & Result, Result>;
};
/** Register on an agevex Agent; the runtime supplies the fenced ToolContext. */
export declare function createTodoTools(refs: TodoFunctions): {
    todo_read: import("ai").Tool<Record<string, never>, Result>;
    todo_write: import("ai").Tool<{
        todos: {
            id: string;
            text: string;
            done: boolean;
        }[];
    }, Result>;
};
export {};
