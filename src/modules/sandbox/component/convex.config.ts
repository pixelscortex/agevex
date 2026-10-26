/**
 * Convex component declaration for the optional sandbox module.
 * The installing host mounts this component separately from core and native Agent.
 * Only sandbox metadata tables and their stable state functions belong to this boundary.
 */
import { defineComponent } from "convex/server";

export default defineComponent("sandbox");
