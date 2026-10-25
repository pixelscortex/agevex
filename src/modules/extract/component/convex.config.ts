// Component runtime source; keep host dependencies and environment access outside this boundary.
import { defineComponent } from "convex/server";
import workflow from "@convex-dev/workflow/convex.config";
const component = defineComponent("agevexExtract");

component.use(workflow);
export default component;
