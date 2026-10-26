import type { TestConvex } from "convex-test";
import { type GenericSchema, type SchemaDefinition } from "convex/server";
import type { ComponentApi } from "./component/_generated/component.js";
export declare const modules: Record<string, () => Promise<unknown>>;
/** Register this component hierarchy under the host-selected mount name for offline tests. */
export declare function register<Schema extends SchemaDefinition<GenericSchema, boolean>>(t: TestConvex<Schema>, name?: string): ComponentApi;
declare const _default: {
    register: typeof register;
    schema: SchemaDefinition<{
        artifacts: import("convex/server").TableDefinition<import("convex/values").VObject<{
            usage?: {
                credits?: number | undefined;
                inputTokens?: number | undefined;
                outputTokens?: number | undefined;
            } | undefined;
            summary?: {
                language?: string | undefined;
                kind: "document" | "text" | "image";
                textBytes: number;
                pages: number;
                preview: string;
            } | undefined;
            failure?: "INVALID_OUTPUT" | "UNSUPPORTED_TYPE" | "UNREADABLE" | "EMPTY" | "TOO_LARGE" | "PROVIDER_UNAVAILABLE" | "OBJECT_UNAVAILABLE" | "CHECKSUM_FAILED" | undefined;
            payloadStorageId?: string | undefined;
            callbacks?: string[] | undefined;
            status: "failed" | "running" | "pending" | "unknown" | "ready" | "released";
            claim: string;
            leaseUntil: number;
            fileId: string;
            version: string;
            backend: string;
            attempt: number;
            optionsHash: string;
        }, {
            status: import("convex/values").VUnion<"failed" | "running" | "pending" | "unknown" | "ready" | "released", [import("convex/values").VLiteral<"pending", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"ready", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"unknown", "required">, import("convex/values").VLiteral<"released", "required">], "required", never>;
            attempt: import("convex/values").VFloat64<number, "required">;
            claim: import("convex/values").VString<string, "required">;
            leaseUntil: import("convex/values").VFloat64<number, "required">;
            summary: import("convex/values").VObject<{
                language?: string | undefined;
                kind: "document" | "text" | "image";
                textBytes: number;
                pages: number;
                preview: string;
            } | undefined, {
                kind: import("convex/values").VUnion<"document" | "text" | "image", [import("convex/values").VLiteral<"text", "required">, import("convex/values").VLiteral<"document", "required">, import("convex/values").VLiteral<"image", "required">], "required", never>;
                textBytes: import("convex/values").VFloat64<number, "required">;
                pages: import("convex/values").VFloat64<number, "required">;
                preview: import("convex/values").VString<string, "required">;
                language: import("convex/values").VString<string | undefined, "optional">;
            }, "optional", "kind" | "textBytes" | "pages" | "preview" | "language">;
            payloadStorageId: import("convex/values").VString<string | undefined, "optional">;
            failure: import("convex/values").VUnion<"INVALID_OUTPUT" | "UNSUPPORTED_TYPE" | "UNREADABLE" | "EMPTY" | "TOO_LARGE" | "PROVIDER_UNAVAILABLE" | "OBJECT_UNAVAILABLE" | "CHECKSUM_FAILED" | undefined, [import("convex/values").VLiteral<"UNSUPPORTED_TYPE", "required">, import("convex/values").VLiteral<"UNREADABLE", "required">, import("convex/values").VLiteral<"EMPTY", "required">, import("convex/values").VLiteral<"INVALID_OUTPUT", "required">, import("convex/values").VLiteral<"TOO_LARGE", "required">, import("convex/values").VLiteral<"PROVIDER_UNAVAILABLE", "required">, import("convex/values").VLiteral<"OBJECT_UNAVAILABLE", "required">, import("convex/values").VLiteral<"CHECKSUM_FAILED", "required">], "optional", never>;
            usage: import("convex/values").VObject<{
                credits?: number | undefined;
                inputTokens?: number | undefined;
                outputTokens?: number | undefined;
            } | undefined, {
                inputTokens: import("convex/values").VFloat64<number | undefined, "optional">;
                outputTokens: import("convex/values").VFloat64<number | undefined, "optional">;
                credits: import("convex/values").VFloat64<number | undefined, "optional">;
            }, "optional", "credits" | "inputTokens" | "outputTokens">;
            callbacks: import("convex/values").VArray<string[] | undefined, import("convex/values").VString<string, "required">, "optional">;
            fileId: import("convex/values").VString<string, "required">;
            backend: import("convex/values").VString<string, "required">;
            version: import("convex/values").VString<string, "required">;
            optionsHash: import("convex/values").VString<string, "required">;
        }, "required", "status" | "claim" | "leaseUntil" | "fileId" | "usage" | "version" | "summary" | "failure" | "backend" | "attempt" | "payloadStorageId" | "callbacks" | "optionsHash" | "usage.credits" | "usage.inputTokens" | "usage.outputTokens" | "summary.kind" | "summary.textBytes" | "summary.pages" | "summary.preview" | "summary.language">, {
            by_identity: ["fileId", "backend", "version", "optionsHash", "_creationTime"];
            by_file: ["fileId", "_creationTime"];
        }, {}, {}>;
        indexes: import("convex/server").TableDefinition<import("convex/values").VObject<{
            entryId?: string | undefined;
            status: "failed" | "running" | "unknown" | "ready" | "released" | "cleaning";
            key: string;
            claim: string;
            leaseUntil: number;
            artifactId: import("convex/values").GenericId<"artifacts">;
            namespace: string;
        }, {
            artifactId: import("convex/values").VId<import("convex/values").GenericId<"artifacts">, "required">;
            namespace: import("convex/values").VString<string, "required">;
            key: import("convex/values").VString<string, "required">;
            status: import("convex/values").VUnion<"failed" | "running" | "unknown" | "ready" | "released" | "cleaning", [import("convex/values").VLiteral<"cleaning", "required">, import("convex/values").VLiteral<"running", "required">, import("convex/values").VLiteral<"unknown", "required">, import("convex/values").VLiteral<"failed", "required">, import("convex/values").VLiteral<"ready", "required">, import("convex/values").VLiteral<"released", "required">], "required", never>;
            claim: import("convex/values").VString<string, "required">;
            leaseUntil: import("convex/values").VFloat64<number, "required">;
            entryId: import("convex/values").VString<string | undefined, "optional">;
        }, "required", "status" | "key" | "claim" | "leaseUntil" | "artifactId" | "namespace" | "entryId">, {
            by_artifact_namespace: ["artifactId", "namespace", "_creationTime"];
        }, {}, {}>;
    }, true>;
    modules: Record<string, () => Promise<unknown>>;
};
export default _default;
