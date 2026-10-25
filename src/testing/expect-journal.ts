import { REPLAY_BOUNDARY } from "./journal.js";
import {
  componentsGeneric,
  type GenericSchema,
  type SchemaDefinition,
  type FunctionReference,
} from "convex/server";
import type { TestConvex } from "convex-test";

type JournalStep = {
  kind: string;
  name: string;
  functionType?: string;
  args: unknown;
  runResult?: unknown;
};
type Turn = {
  id: string;
  kind: "turn" | "loop";
  args: { assignmentId: string; executionId?: string; version: number };
  steps: JournalStep[];
};
/** Address nested functions through a real test-only component forwarding mutation/query. */
export async function workflowCall<Result, Schema extends SchemaDefinition<GenericSchema, boolean>>(
  t: TestConvex<Schema>,
  path: string,
  type: "query" | "mutation",
  module: string,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Result> {
  const [component, lane] = path.split("/");
  const payload = { lane, module, name, args };
  if (type === "query")
    return t.query(
      componentsGeneric()[component].agevexTest.read as unknown as FunctionReference<
        "query",
        "internal",
        typeof payload,
        Result
      >,
      payload,
    );
  return t.mutation(
    componentsGeneric()[component].agevexTest.write as unknown as FunctionReference<
      "mutation",
      "internal",
      typeof payload,
      Result
    >,
    payload,
  );
}

/**
 * Compare persisted step names, kinds, arguments and results with a committed
 * fixture, then execute each recorded turn through Workflow's real replay
 * engine. A clone keeps the original callback from notifying its parent again.
 * No historical action may run: replay must consume every recorded step.
 */
export async function expectJournalUnchanged<
  Schema extends SchemaDefinition<GenericSchema, boolean>,
>(t: TestConvex<Schema>, path: string, fixture: unknown) {
  const turns = await workflowCall<Turn[], Schema>(t, path, "query", "agevexJournal", "turns");
  const normalized = turns.map((turn) => {
    const replace = (value: unknown): unknown => {
      if (typeof value === "string")
        return (
          turn.args.executionId ? value.replaceAll(turn.args.executionId, "$execution") : value
        ).replaceAll(turn.args.assignmentId, "$assignment");
      if (Array.isArray(value)) return value.map(replace);
      if (value && typeof value === "object")
        return Object.fromEntries(Object.entries(value).map(([key, v]) => [key, replace(v)]));
      return value;
    };
    return {
      kind: turn.kind,
      version: turn.args.version,
      steps: turn.steps.map((step) =>
        replace({
          kind: step.kind,
          name: step.name,
          functionType: step.functionType,
          args: step.args,
          runResult: step.runResult,
        }),
      ),
    };
  });
  // Object key order does not matter to the comparison, but array/step order
  // does. This catches argument drift as well as inserted or reordered steps.
  const canonical = (value: unknown): string =>
    JSON.stringify(value, (_key, v) =>
      v && typeof v === "object" && !Array.isArray(v)
        ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)))
        : v,
    );
  if (canonical(normalized) !== canonical(fixture))
    throw new Error(
      `Workflow journal changed. Expected ${JSON.stringify(fixture)}; recorded ${JSON.stringify(normalized)}`,
    );
  for (const turn of turns) {
    const replayId = await workflowCall<string, Schema>(
      t,
      path,
      "mutation",
      "agevexJournal",
      "clone",
      { workflowId: turn.id },
    );
    const result = await workflowCall<{ kind: string; error?: string } | null, Schema>(
      t,
      path,
      "query",
      "agevexJournal",
      "result",
      { workflowId: replayId },
    );
    if (
      turn.kind === "loop"
        ? result?.kind !== "failed" || !result.error?.includes(REPLAY_BOUNDARY)
        : result?.kind !== "success"
    )
      throw new Error(`Workflow replay failed: ${JSON.stringify(result)}`);
  }
}
