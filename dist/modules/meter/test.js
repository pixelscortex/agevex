import { componentsGeneric } from "convex/server";
import aggregate from "@convex-dev/aggregate/test";
import workpool from "@convex-dev/workpool/test";
import schema from "./component/schema.js";
const modules = import.meta.glob("./component/**/*.ts");
/** Register meter and its aggregate/Workpool children in one deterministic test store. */
export function register(t, name = "meter") {
    t.registerComponent(name, schema, modules);
    aggregate.register(t, `${name}/costByThread`);
    aggregate.register(t, `${name}/costBySubject`);
    workpool.register(t, `${name}/workpool`);
    return componentsGeneric()[name];
}
export default { register, schema, modules };
