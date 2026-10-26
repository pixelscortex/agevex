/**
 * EXTRACT component definition and nested Workflow installation.
 * Hosts mount this through agevex/extract/convex.config alongside native Agent.
 * Workpool is owned by the nested Workflow component rather than extraction tables.
 */
import workflow from "@convex-dev/workflow/convex.config";
import { defineComponent } from "convex/server";
const component = defineComponent("agevexExtract");
component.use(workflow);
export default component;
