export type AttributeValue = {
    stringValue: string;
} | {
    intValue: string;
} | {
    doubleValue: number;
} | {
    boolValue: boolean;
};
export type Attribute = {
    key: string;
    value: AttributeValue;
};
export type Span = {
    traceId: string;
    spanId: string;
    parentSpanId?: string;
    name: string;
    kind: 1 | 3;
    startTimeUnixNano: string;
    endTimeUnixNano: string;
    attributes: Attribute[];
    status: {
        code: 1 | 2;
        message?: string;
    };
};
export type OtlpPayload = {
    resourceSpans: {
        resource: {
            attributes: Attribute[];
        };
        scopeSpans: {
            scope: {
                name: string;
            };
            spans: Span[];
        }[];
    }[];
};
export type Sanitize = (value: unknown, attribute: string) => unknown;
/** Mark dropped attributes once so size-ceiling loss remains visible to the reader. */
export declare function markTruncated(attributes: Attribute[]): void;
/** Bound the encoded OTLP list, including JSON escaping and per-entry overhead. */
export declare function attributeWriter(sanitize?: Sanitize): (attributes: Attribute[], key: string, input: unknown) => void;
/** Wrap a serialized turn in the stable agevex resource/scope envelope for every exporter. */
export declare function payload(spans: Span[]): OtlpPayload;
/** WebCrypto is available in Convex V8; no Buffer, node:crypto or global OTel SDK. */
export declare function hash(value: string, length: number): Promise<string>;
/** Timestamp span callbacks in OTLP nanoseconds using the host clock. */
export declare const now: () => string;
