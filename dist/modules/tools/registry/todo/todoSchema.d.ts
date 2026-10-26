/**
 * Host schema snippet for one bounded todo list per owner and thread.
 * Installers spread todoTables into their schema; todoState uses the owner/thread
 * index for current-state reads, replacement writes and explicit host cleanup.
 */
import { type DataModelFromSchemaDefinition } from "convex/server";
/**
 * Spread into the host's defineSchema; no agevex component table is added.
 * Agent 0.7.7 only supports userId/title/summary metadata, so this small host
 * table is necessary: @convex-dev/agent/src/client/threads.ts:18-30,55-63.
 */
export declare const todoTables: {
    agevexTodos: import("convex/server").TableDefinition<import("convex/values").VObject<{
        subject: string;
        threadId: string;
        todos: {
            id: string;
            done: boolean;
            text: string;
        }[];
    }, {
        subject: import("convex/values").VString<string, "required">;
        threadId: import("convex/values").VString<string, "required">;
        todos: import("convex/values").VArray<{
            id: string;
            done: boolean;
            text: string;
        }[], import("convex/values").VObject<{
            id: string;
            done: boolean;
            text: string;
        }, {
            id: import("convex/values").VString<string, "required">;
            text: import("convex/values").VString<string, "required">;
            done: import("convex/values").VBoolean<boolean, "required">;
        }, "required", "id" | "done" | "text">, "required">;
    }, "required", "subject" | "threadId" | "todos">, {
        by_owner_thread: ["subject", "threadId", "_creationTime"];
    }, {}, {}>;
};
declare const schema: import("convex/server").SchemaDefinition<{
    agevexTodos: import("convex/server").TableDefinition<import("convex/values").VObject<{
        subject: string;
        threadId: string;
        todos: {
            id: string;
            done: boolean;
            text: string;
        }[];
    }, {
        subject: import("convex/values").VString<string, "required">;
        threadId: import("convex/values").VString<string, "required">;
        todos: import("convex/values").VArray<{
            id: string;
            done: boolean;
            text: string;
        }[], import("convex/values").VObject<{
            id: string;
            done: boolean;
            text: string;
        }, {
            id: import("convex/values").VString<string, "required">;
            text: import("convex/values").VString<string, "required">;
            done: import("convex/values").VBoolean<boolean, "required">;
        }, "required", "id" | "done" | "text">, "required">;
    }, "required", "subject" | "threadId" | "todos">, {
        by_owner_thread: ["subject", "threadId", "_creationTime"];
    }, {}, {}>;
}, true>;
export type TodoDataModel = DataModelFromSchemaDefinition<typeof schema>;
export {};
