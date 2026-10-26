/** Drop optional undefined fields; map undefined array items to null (as JSON
 * does) so indices are kept. Preserve invalid values for assertJson to reject. Never JSON.stringify first: it hides NaN, Dates and other non-JSON
 * values. Bound recursion before walking callback output (including cycles).
 */
export declare function definedAskValue(value: unknown, depth?: number): unknown;
/** Custom input is complete; only the default question-only shape needs a
 * separate question projection. Each question is copied exactly once.
 */
export declare function askProjection(input: unknown): {
    input: null;
    question: string;
} | {
    input: unknown;
    question?: undefined;
};
/** Check both the component response and public projection, with the real
 * identifiers/envelope. 256 items * (16 KiB including array reservation) <=4 MiB.
 */
export declare function oversizedAskItem(call: {
    input: unknown;
    [key: string]: unknown;
}): boolean;
