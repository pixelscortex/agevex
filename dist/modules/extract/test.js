/// <reference types="vite/client" />
/**
 * convex-test registration for EXTRACT and its nested Workflow/Workpool children.
 * Tests import this helper so component paths match the installed production hierarchy.
 * The returned component reference uses the same public API as host registration.
 */
import workflow from "@convex-dev/workflow/test";
import workpool from "@convex-dev/workpool/test";
import { componentsGeneric } from "convex/server";
import schema from "./component/schema.js";
export const modules = import.meta.glob("./component/**/*.ts");
/** Register this component hierarchy under the host-selected mount name for offline tests. */
export function register(t, name = "agevexExtract") {
    t.registerComponent(name, schema, modules);
    workflow.register(t, name + "/workflow");
    workpool.register(t, name + "/workflow/workpool");
    return componentsGeneric()[name];
}
export default { register, schema, modules };
