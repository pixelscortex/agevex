/**
 * The agevex component definition: mounts two independent Workflow
 * components (root and child lanes, see workflows/lanes.ts).
 */
import { defineComponent } from "convex/server";
import workflow from "@convex-dev/workflow/convex.config";

const component = defineComponent("agevex");

component.use(workflow, { name: "rootWorkflow" });
component.use(workflow, { name: "childWorkflow" });
export default component;
