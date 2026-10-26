// Public entry point of the `agevex` package (`.` export).
//
// Re-exports the managed `Agent`, `registerAgent`, the reserved tool names, the
// slot contracts, `defineOnceTool`, structured tasks and the public types. The
// implementation is organised by concept; see `client/README.md` for the map.
export { Agent } from "./agent.js";
export { DELEGATE_TOOL_NAME, MESSAGE_CHILD_TOOL_NAME, ASK_PARENT_TOOL_NAME, registerAgent, } from "./runtime.js";
export { LIMITS, PLATFORM } from "../component/limits.js";
export { defineOnceTool } from "./once.js";
export { defineTask, runTask } from "./tasks.js";
export { assertFormSchema, validateAnswer, } from "../shared/decisions.js";
