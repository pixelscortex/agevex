// Component entry point.
//
// Agevex mounts Workpool only. It is deliberately not the native Agent component
// and not a Workflow: threads, messages, generation and streaming stay owned by
// the host's native Agent component, and this component only manages assignment
// state, queueing and dispatch. No host Workflow export is required.

import { defineComponent } from "convex/server";
import workpool from "@convex-dev/workpool/convex.config";

const component = defineComponent("agevex");
component.use(workpool);
export default component;
