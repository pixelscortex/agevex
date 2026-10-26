import { type GenericSchema, type SchemaDefinition } from "convex/server";
import type { TestConvex } from "convex-test";
type AnySchema = SchemaDefinition<GenericSchema, boolean>;
/** Address nested functions through a real test-only component forwarding mutation/query. */
export declare function workflowCall<Result, Schema extends AnySchema>(t: TestConvex<Schema>, path: string, type: "query" | "mutation", module: string, name: string, args?: Record<string, unknown>): Promise<Result>;
/**
 * Compare persisted step names, kinds, arguments and results with a committed
 * fixture, then execute each recorded turn through Workflow's real replay
 * engine. A clone keeps the original callback from notifying its parent again.
 * No historical action may run: replay must consume every recorded step.
 */
export declare function expectJournalUnchanged<Schema extends AnySchema>(t: TestConvex<Schema>, path: string, fixture: unknown): Promise<void>;
export {};
