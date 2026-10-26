import { componentsGeneric } from "convex/server";
import schema from "./component/schema.js";
export const modules = import.meta.glob("./component/**/*.ts");
/** Register only the sandbox component; mount the native Agent separately for exports. */
export function register(t, name = "sandbox") {
    t.registerComponent(name, schema, modules);
    return componentsGeneric()[name];
}
export default { register, schema, modules };
