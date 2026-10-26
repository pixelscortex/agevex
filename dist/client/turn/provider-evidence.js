import { LIMITS } from "../../component/limits.js";
/** No synthetic request ids; oversized ids stay unavailable for reconciliation. */
export function providerEvidence(metadata, requestId) {
    if (!requestId || new TextEncoder().encode(requestId).length > LIMITS.factBytes)
        return metadata;
    return { ...metadata, agevex: { requestId } };
}
