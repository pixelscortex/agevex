// Host-side module API and helpers; this code is imported by the installing app.
import { LIMITS, TRUNCATED, boundedValue, bytes, truncate } from "./limits.js";

export type AttributeValue =
  | { stringValue: string }
  | { intValue: string }
  | { doubleValue: number }
  | { boolValue: boolean };
export type Attribute = { key: string; value: AttributeValue };
export type Span = {
  traceId: string;
  spanId: string;
  parentSpanId?: string;
  name: string;
  kind: 1 | 3;
  startTimeUnixNano: string;
  endTimeUnixNano: string;
  attributes: Attribute[];
  status: { code: 1 | 2; message?: string };
};
export type OtlpPayload = {
  resourceSpans: {
    resource: { attributes: Attribute[] };
    scopeSpans: { scope: { name: string }; spans: Span[] }[];
  }[];
};
export type Sanitize = (value: unknown, attribute: string) => unknown;

const marker: Attribute = { key: "agevex.truncated", value: { boolValue: true } };

export function markTruncated(attributes: Attribute[]): void {
  if (!attributes.some((entry) => entry.key === marker.key)) attributes.push({ ...marker });
}

/** Bound the encoded OTLP list, including JSON escaping and per-entry overhead. */
export function attributeWriter(sanitize?: Sanitize) {
  return (attributes: Attribute[], key: string, input: unknown): void => {
    if (input === undefined) return;

    try {
      let value = boundedValue(input);

      if (sanitize) value = boundedValue(sanitize(value, key));

      if (value === undefined) return;

      let encoded: AttributeValue;

      if (typeof value === "boolean") encoded = { boolValue: value };
      else if (typeof value === "number")
        encoded = Number.isSafeInteger(value)
          ? { intValue: String(value) }
          : { doubleValue: value };
      else {
        const text = typeof value === "string" ? value : JSON.stringify(value);
        // Count the JSON form as well: a NUL character expands to six ASCII bytes.
        let bounded = truncate(text, LIMITS.maxValueBytes);

        if (bytes(JSON.stringify(bounded)) > LIMITS.maxValueBytes) bounded = TRUNCATED;

        encoded = { stringValue: bounded };
      }

      const previous = attributes.findIndex((entry) => entry.key === key);
      const next = attributes.filter((entry) => entry.key !== key);
      const entry = { key, value: encoded };

      next.push(entry);

      // Reserve the truncation marker before admitting any value. It must remain
      // possible to explain discarded content even when this span is at the ceiling.
      if (bytes(JSON.stringify([...next, marker])) > LIMITS.maxAttributeBytes) {
        markTruncated(attributes);

        return;
      }

      if (previous >= 0) attributes[previous] = entry;
      else attributes.push(entry);

      if (JSON.stringify(encoded).includes(TRUNCATED)) markTruncated(attributes);
    } catch {
      // A throwing getter/sanitizer must neither leak the raw value nor fail paid work.
      markTruncated(attributes);
    }
  };
}

export function payload(spans: Span[]): OtlpPayload {
  return {
    resourceSpans: [
      {
        resource: { attributes: [{ key: "service.name", value: { stringValue: "agevex" } }] },
        scopeSpans: [{ scope: { name: "agevex" }, spans }],
      },
    ],
  };
}

/** WebCrypto is available in Convex V8; no Buffer, node:crypto or global OTel SDK. */
export async function hash(value: string, length: number): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));

  const hex = Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, length);

  // OTLP disallows the all-zero identifier, even though a SHA-256 prefix hitting
  // it is extraordinarily unlikely. Keep that edge case deterministic too.
  return /^0+$/.test(hex) ? hex.slice(0, -1) + "1" : hex;
}

export const now = () => String(BigInt(Date.now()) * BigInt(LIMITS.nanosPerMillisecond));
