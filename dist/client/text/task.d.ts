import type { RuntimeContext } from "../registration/context.js";
/** Export as refs.textTask. The component's child Workflow never retries it. */
export declare function buildTextTask(rt: RuntimeContext): import("convex/server").RegisteredAction<"internal", {
    kind: "title" | "summary";
    key: string;
    assignmentId: string;
}, Promise<null>>;
