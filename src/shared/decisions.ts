// Shared decision bounds and a deliberately small, closed JSON Schema form dialect.
// Reject unsupported keywords rather than silently accepting an unchecked constraint.
import { ConvexError, getConvexSize, v, type Infer, type Value } from "convex/values";

export const DECISION_LIMITS = {
  valueBytes: 16 << 10,
  schemaBytes: 8 << 10,
  sourceBytes: 16 << 10,
  itemBytes: 16 << 10,
  outputBytes: 4 << 20,
  depth: 8,
  valueDepth: 32,
  fields: 32,
  assignments: 16,
  questionChars: 2000,
} as const;
export const decisionValidator = v.union(
  v.object({ kind: v.literal("reject"), reason: v.optional(v.string()) }),
  v.object({
    kind: v.literal("approve"),
    edit: v.optional(v.object({ input: v.any() })),
  }),
);
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
export function assertJson(value: unknown, maxBytes: number = DECISION_LIMITS.valueBytes): void {
  const visit = (part: unknown, depth: number): void => {
    if (depth > DECISION_LIMITS.valueDepth) throw new ConvexError({ code: "INVALID_VALUE" });

    if (part === null || typeof part === "string" || typeof part === "boolean") return;

    if (typeof part === "number" && Number.isFinite(part)) return;

    if (Array.isArray(part)) return part.forEach((item) => visit(item, depth + 1));

    if (typeof part !== "object" || !part || Object.getPrototypeOf(part) !== Object.prototype)
      throw new ConvexError({ code: "INVALID_VALUE" });

    Object.values(part).forEach((item) => visit(item, depth + 1));
  };

  visit(value, 0);

  if (
    Math.max(
      getConvexSize(value as Value),
      new TextEncoder().encode(JSON.stringify(value)).length,
    ) > maxBytes
  )
    throw new ConvexError({ code: "VALUE_TOO_LARGE" });
}

/** Validate the app's schema at construction, including all nested fields and keywords. */
export function assertFormSchema(schema: JsonSchema): void {
  assertJson(schema, DECISION_LIMITS.schemaBytes);
  let fields = 0;

  const visit = (node: JsonSchema, depth: number): void => {
    if (
      !node ||
      typeof node !== "object" ||
      depth > DECISION_LIMITS.depth ||
      Object.keys(node).some((key) => !FORM_KEYWORDS.includes(key)) ||
      !["object", "array", "string", "number", "integer", "boolean", "null"].includes(node.type)
    )
      throw new Error("INVALID_FORM_SCHEMA");

    for (const key of [
      "minimum",
      "maximum",
      "minLength",
      "maxLength",
      "minItems",
      "maxItems",
    ] as const)
      if (
        node[key] !== undefined &&
        (!Number.isFinite(node[key]) ||
          (key !== "minimum" &&
            key !== "maximum" &&
            (!Number.isSafeInteger(node[key]) || node[key]! < 0)))
      )
        throw new Error("INVALID_FORM_SCHEMA");

    if (
      (node.title !== undefined && typeof node.title !== "string") ||
      (node.description !== undefined && typeof node.description !== "string")
    )
      throw new Error("INVALID_FORM_SCHEMA");

    if (node.enum !== undefined && (!Array.isArray(node.enum) || !node.enum.length))
      throw new Error("INVALID_FORM_SCHEMA");

    if (node.additionalProperties !== undefined && typeof node.additionalProperties !== "boolean")
      throw new Error("INVALID_FORM_SCHEMA");

    if (
      node.properties !== undefined &&
      (node.type !== "object" ||
        !node.properties ||
        typeof node.properties !== "object" ||
        Array.isArray(node.properties))
    )
      throw new Error("INVALID_FORM_SCHEMA");

    for (const child of Object.values(node.properties ?? {})) {
      if (++fields > DECISION_LIMITS.fields) throw new Error("INVALID_FORM_SCHEMA");

      visit(child, depth + 1);
    }

    if (
      node.required !== undefined &&
      (!Array.isArray(node.required) ||
        node.required.some(
          (key) =>
            typeof key !== "string" ||
            !Object.prototype.hasOwnProperty.call(node.properties ?? {}, key),
        ))
    )
      throw new Error("INVALID_FORM_SCHEMA");

    if (node.items) visit(node.items, depth + 1);

    if (node.type === "array" && !node.items) throw new Error("INVALID_FORM_SCHEMA");
  };

  visit(schema, 0);
}

/** Validate without coercion; a malformed answer must leave the native call pending. */
export function validateAnswer(value: unknown, schema?: JsonSchema): void {
  assertJson(value);

  if (!schema) {
    if (typeof value !== "string" || !value.trim())
      throw new ConvexError({ code: "INVALID_MESSAGE" });

    return;
  }

  assertFormSchema(schema);

  const matches = (node: JsonSchema, part: unknown): boolean => {
    if (node.enum && !node.enum.some((entry) => canonicalJson(entry) === canonicalJson(part)))
      return false;

    if (node.type === "null") return part === null;

    if (node.type === "array")
      return (
        Array.isArray(part) &&
        part.length >= (node.minItems ?? 0) &&
        part.length <= (node.maxItems ?? Infinity) &&
        part.every((item) => matches(node.items!, item))
      );

    if (node.type === "object") {
      if (!part || typeof part !== "object" || Array.isArray(part)) return false;

      const record = part as Record<string, unknown>;

      return (
        (node.required ?? []).every((key) => Object.prototype.hasOwnProperty.call(record, key)) &&
        Object.entries(record).every(([key, item]) =>
          Object.prototype.hasOwnProperty.call(node.properties ?? {}, key)
            ? matches(node.properties![key], item)
            : node.additionalProperties !== false,
        )
      );
    }

    if (node.type === "string")
      return (
        typeof part === "string" &&
        Array.from(part).length >= (node.minLength ?? 0) &&
        Array.from(part).length <= (node.maxLength ?? Infinity)
      );

    if (node.type === "boolean") return typeof part === "boolean";

    return (
      typeof part === "number" &&
      (node.type !== "integer" || Number.isInteger(part)) &&
      part >= (node.minimum ?? -Infinity) &&
      part <= (node.maximum ?? Infinity)
    );
  };

  if (!matches(schema, value)) throw new ConvexError({ code: "INVALID_ANSWER" });
}

/** Larger UTF-8 JSON/Convex representation governs every decision envelope. */
export function decisionBytes(value: unknown): number {
  return Math.max(
    getConvexSize(value as Value),
    new TextEncoder().encode(JSON.stringify(value)).length,
  );
}

/** Canonical JSON treats object order as transport detail, including form enum values. */
export function canonicalJson(value: unknown): string {
  const canonical = (part: unknown): unknown =>
    Array.isArray(part)
      ? part.map(canonical)
      : part && typeof part === "object"
        ? Object.fromEntries(
            Object.entries(part)
              .sort(([a], [b]) => a.localeCompare(b))
              .map(([key, item]) => [key, canonical(item)]),
          )
        : part;

  return JSON.stringify(canonical(value));
}

const FORM_KEYWORDS: readonly string[] = [
  "type",
  "properties",
  "required",
  "additionalProperties",
  "items",
  "enum",
  "description",
  "title",
  "minimum",
  "maximum",
  "minLength",
  "maxLength",
  "minItems",
  "maxItems",
];
