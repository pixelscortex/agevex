/// <reference types="vite/client" />
import type { TestConvex } from "convex-test";
import { componentsGeneric, type GenericSchema, type SchemaDefinition } from "convex/server";
import workflow from "@convex-dev/workflow/test";
import workpool from "@convex-dev/workpool/test";
import type { ComponentApi } from "./component/_generated/component.js";
import schema from "./component/schema.js";

const modules: Record<string, () => Promise<unknown>> = {
  ...import.meta.glob("./component/**/*.ts"),
  "./component/agevexTest.ts": () => import("./testing/bridge.js"),
};

/** Register Agevex and both nested Workflow/Workpool lanes, not the sibling native Agent. */
export function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(
  t: TestConvex<Schema>,
  name = "agevex",
) {
  t.registerComponent(name, schema, modules);
  registerWorkflow(t, `${name}/rootWorkflow`);
  registerWorkflow(t, `${name}/childWorkflow`);

  return componentsGeneric()[name] as unknown as ComponentApi;
}
export default { register, schema, modules };

import { mockModel } from "@convex-dev/agent";
import type { LanguageModelV4Content } from "@ai-sdk/provider";

/**
 * Native mockModel currently emits finishReason=stop even for tool calls. Keep
 * its real streaming backend and adjust that one provider fact so scripted
 * tests exercise the same slice continuation as real tool-capable providers.
 */
export function scriptedModel(steps: LanguageModelV4Content[][]) {
  const model = mockModel({ contentSteps: steps });
  const stream = model.doStream.bind(model);

  model.doStream = async (args) => {
    const result = await stream(args);
    let calledTool = false;

    return {
      ...result,
      stream: result.stream.pipeThrough(
        new TransformStream({
          transform(part, controller) {
            if (part.type === "tool-call") calledTool = true;

            controller.enqueue(
              part.type === "finish" && calledTool
                ? { ...part, finishReason: { unified: "tool-calls", raw: "tool_calls" } }
                : part,
            );
          },
        }),
      ),
    };
  };

  return model;
}

/** Same real Workflow/Workpool stack, plus journal inspection for tests only. */
export function registerWorkflow<Schema extends SchemaDefinition<GenericSchema, boolean>>(
  t: TestConvex<Schema>,
  name: string,
) {
  t.registerComponent(name, workflow.schema, {
    ...workflow.modules,
    "./component/agevexJournal.ts": () => import("./testing/journal.js"),
  });

  workpool.register(t, `${name}/workpool`);
}
export { expectJournalUnchanged } from "./testing/expect-journal.js";
