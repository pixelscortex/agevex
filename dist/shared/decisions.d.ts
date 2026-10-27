import { type Infer } from "convex/values";
export { canonicalJson, valueBytes as decisionBytes } from "./json.js";
export declare const DECISION_LIMITS: {
    readonly valueBytes: number;
    readonly schemaBytes: number;
    readonly proposalBytes: number;
    readonly proposalEnvelopeBytes: 512;
    readonly identifierChars: 512;
    readonly itemBytes: number;
    readonly arrayEnvelopeBytes: 2;
    readonly outputBytes: number;
    readonly depth: 8;
    readonly valueDepth: 32;
    readonly fields: 32;
    readonly assignments: 16;
    readonly questionChars: 2000;
};
export declare const decisionValidator: import("convex/values").VUnion<{
    reason?: string | undefined;
    kind: "reject";
} | {
    edit?: {
        input: any;
    } | undefined;
    kind: "approve";
}, [import("convex/values").VObject<{
    reason?: string | undefined;
    kind: "reject";
}, {
    kind: import("convex/values").VLiteral<"reject", "required">;
    reason: import("convex/values").VString<string | undefined, "optional">;
}, "required", "kind" | "reason">, import("convex/values").VObject<{
    edit?: {
        input: any;
    } | undefined;
    kind: "approve";
}, {
    kind: import("convex/values").VLiteral<"approve", "required">;
    edit: import("convex/values").VObject<{
        input: any;
    } | undefined, {
        input: import("convex/values").VAny<any, "required", string>;
    }, "optional", "input" | `input.${string}`>;
}, "required", "kind" | "edit" | "edit.input" | `edit.input.${string}`>], "required", "kind" | "reason" | "edit" | "edit.input" | `edit.input.${string}`>;
export type Decision = Infer<typeof decisionValidator>;
export type JsonSchema = {
    type: "object" | "array" | "string" | "number" | "integer" | "boolean" | "null";
    properties?: Record<string, JsonSchema>;
    required?: string[];
    additionalProperties?: boolean;
    items?: JsonSchema;
    enum?: unknown[];
    description?: string;
    title?: string;
    minimum?: number;
    maximum?: number;
    minLength?: number;
    maxLength?: number;
    minItems?: number;
    maxItems?: number;
};
/** JSON only: no undefined, non-finite numbers, bytes, ids-as-objects or prototypes. */
export declare function assertJson(value: unknown, maxBytes?: number): void;
/** Validate the app's schema at construction, including all nested fields and keywords. */
export declare function assertFormSchema(schema: JsonSchema): void;
/** Validate without coercion; a malformed answer must leave the native call pending. */
export declare function validateAnswer(value: unknown, schema?: JsonSchema): void;
