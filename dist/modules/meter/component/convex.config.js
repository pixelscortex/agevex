/**
 * Mount definition for the optional meter component.
 * Two aggregate children store thread and subject/run projections independently.
 * Workpool executes on-demand evidence and delivery jobs with explicit retries.
 * Core imports none of these children; the host chooses whether to mount meter.
 */
import { defineComponent } from "convex/server";
import aggregate from "@convex-dev/aggregate/convex.config";
import workpool from "@convex-dev/workpool/convex.config";
const component = defineComponent("agevexMeter");
component.use(aggregate, { name: "costByThread" });
component.use(aggregate, { name: "costBySubject" });
component.use(workpool);
export default component;
