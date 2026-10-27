import type { RuntimeContext } from "../registration/context.js";
/** Export as refs.textTask. Workflow retries are disabled for this action. */
export declare function buildTextTask(rt: RuntimeContext): import("convex/server").RegisteredAction<"internal", {
    kind: "title";
    key: string;
    assignmentId: string;
}, Promise<null>>;
