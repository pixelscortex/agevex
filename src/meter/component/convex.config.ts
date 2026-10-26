import { defineComponent } from "convex/server";
import aggregate from "@convex-dev/aggregate/convex.config";
import workpool from "@convex-dev/workpool/convex.config";

const component = defineComponent("agevexMeter");

component.use(aggregate, { name: "costByThread" });
component.use(aggregate, { name: "costBySubject" });
component.use(workpool);
export default component;
