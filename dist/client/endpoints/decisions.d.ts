import { type Tool } from "ai";
import type { GenericDataModel, GenericMutationCtx } from "convex/server";
import { type Decision } from "../../shared/decisions.js";
import type { EndpointContext } from "./access.js";
/** Resolve by the recorded call's name. An unregistered/provider tool cannot be edited.
 * Validation and component response share the host mutation's transaction, so invalid
 * edits never create a receipt, annotation, native response or wake.
 */
export declare function effectiveInput(ep: EndpointContext, ctx: GenericMutationCtx<GenericDataModel>, row: {
    assignmentId: string;
    subject: string;
    native: {
        declaredTools: Record<string, Tool>;
    };
}, approvalId: string, decision: Decision): Promise<{
    effectiveInput?: undefined;
} | {
    effectiveInput: any;
}>;
