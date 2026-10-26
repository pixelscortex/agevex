import { componentsGeneric } from "convex/server";
import workflow from "@convex-dev/workflow/test";
import workpool from "@convex-dev/workpool/test";
import schema from "./component/schema.js";
const modules = {
    ...import.meta.glob("./component/**/*.ts"),
    "./component/agevexTest.ts": () => import("./testing/bridge.js"),
};
/** Register Agevex and both nested Workflow/Workpool lanes, not the sibling native Agent. */
export function register(t, name = "agevex") {
    t.registerComponent(name, schema, modules);
    registerWorkflow(t, `${name}/rootWorkflow`);
    registerWorkflow(t, `${name}/childWorkflow`);
    return componentsGeneric()[name];
}
export default { register, schema, modules };
import { mockModel } from "@convex-dev/agent";
/**
 * Native mockModel currently emits finishReason=stop even for tool calls. Keep
 * its real streaming backend and adjust that one provider fact so scripted
 * tests exercise the same slice continuation as real tool-capable providers.
 */
export function scriptedModel(steps) {
    const model = mockModel({ contentSteps: steps });
    const stream = model.doStream.bind(model);
    model.doStream = async (args) => {
        const result = await stream(args);
        let calledTool = false;
        return {
            ...result,
            stream: result.stream.pipeThrough(new TransformStream({
                transform(part, controller) {
                    if (part.type === "tool-call")
                        calledTool = true;
                    controller.enqueue(part.type === "finish" && calledTool
                        ? { ...part, finishReason: { unified: "tool-calls", raw: "tool_calls" } }
                        : part);
                },
            })),
        };
    };
    return model;
}
/** Same real Workflow/Workpool stack, plus journal inspection for tests only. */
export function registerWorkflow(t, name) {
    t.registerComponent(name, workflow.schema, {
        ...workflow.modules,
        "./component/agevexJournal.ts": () => import("./testing/journal.js"),
    });
    workpool.register(t, `${name}/workpool`);
}
export { expectJournalUnchanged } from "./testing/expect-journal.js";
