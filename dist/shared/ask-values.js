// Ask normalization and projection are shared by the save fence and human reads.
import { ConvexError } from "convex/values";
import { DECISION_LIMITS, decisionBytes } from "./decisions.js";
/** Drop optional undefined fields; map undefined array items to null (as JSON
 * does) so indices are kept. Preserve invalid values for assertJson to reject. Never JSON.stringify first: it hides NaN, Dates and other non-JSON
 * values. Bound recursion before walking callback output (including cycles).
 */
export function definedAskValue(value, depth = 0) {
    if (depth > DECISION_LIMITS.valueDepth)
        throw new ConvexError({ code: "INVALID_VALUE" });
    if (Array.isArray(value))
        return value.map((item) => (item === undefined ? null : definedAskValue(item, depth + 1)));
    if (value && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
        return Object.fromEntries(Object.entries(value)
            .filter(([, item]) => item !== undefined)
            .map(([key, item]) => [key, definedAskValue(item, depth + 1)]));
    return value;
}
/** Custom input is complete; only the default question-only shape needs a
 * separate question projection. Each question is copied exactly once.
 */
export function askProjection(input) {
    if (input && typeof input === "object" && Object.keys(input).length === 1) {
        const question = input.question;
        if (typeof question === "string")
            return { input: null, question };
    }
    return { input };
}
/** Check both the component response and public projection, with the real
 * identifiers/envelope. 256 items * (16 KiB including array reservation) <=4 MiB.
 */
export function oversizedAskItem(call) {
    return (decisionBytes(call) > DECISION_LIMITS.itemBytes ||
        decisionBytes({ ...call, ...askProjection(call.input), editable: false }) >
            DECISION_LIMITS.itemBytes - DECISION_LIMITS.arrayEnvelopeBytes);
}
