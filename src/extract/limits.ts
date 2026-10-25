/** Hard ceilings keep provider bodies out of rows and every tool response bounded. */
export const LIMITS = {
  maxBytes: { document: 50_000_000, image: 10_000_000, text: 8 * 2 ** 20 },
  payloadBytes: 32 * 2 ** 20,
  readBytes: 2 ** 20,
  pages: 100,
  totalPages: 10_000,
  toolBytes: 64 * 2 ** 10,
  summaryBytes: 1024,
  identifierBytes: 256,
  hashBytes: 64,
  urlBytes: 4096,
  queryBytes: 4096,
  optionsBytes: 4096,
  backends: 32,
  leaseMs: 10 * 60 * 1000,
  indexLeaseMs: 10 * 60 * 1000,
  providerMs: 5 * 60 * 1000,
  outputTokens: 4096,
  searchResults: 10,
  chunkBytes: 8192,
  minChunkBytes: 1024,
  indexChunks: 1024,
  ragBatch: 100,
  vectorNumberBytes: 8,
  embeddingDimensions: [128, 256, 512, 768, 1024, 1408, 1536, 2048, 3072, 4096],
  indexBytes: 2 ** 20,
  embeddingDimension: 4096,
  workflowVersion: 1,
  initialAttempt: 1,
} as const;
export type ExtractLimits = {
  maxBytes: { document: number; image: number; text: number };
  payloadBytes: number;
  indexLeaseMs: number;
};
export function integer(value: number, max: number, min = 0): number {
  if (!Number.isSafeInteger(value) || value < min || value > max)
    throw new Error("INVALID_EXTRACT_ARGUMENT");
  return value;
}
export const utf8 = (text: string) => new TextEncoder().encode(text);
export function bounded(value: string, max: number = LIMITS.identifierBytes): string {
  if (typeof value !== "string" || !value.length || utf8(value).length > max)
    throw new Error("INVALID_EXTRACT_ARGUMENT");
  return value;
}
export function resolveLimits(
  value?: Partial<Omit<ExtractLimits, "maxBytes">> & {
    maxBytes?: Partial<ExtractLimits["maxBytes"]>;
  },
): ExtractLimits {
  return {
    maxBytes: {
      document: integer(
        value?.maxBytes?.document ?? LIMITS.maxBytes.document,
        LIMITS.maxBytes.document,
        1,
      ),
      image: integer(value?.maxBytes?.image ?? LIMITS.maxBytes.image, LIMITS.maxBytes.image, 1),
      text: integer(value?.maxBytes?.text ?? LIMITS.maxBytes.text, LIMITS.maxBytes.text, 1),
    },
    payloadBytes: integer(value?.payloadBytes ?? LIMITS.payloadBytes, LIMITS.payloadBytes, 1),
    indexLeaseMs: integer(value?.indexLeaseMs ?? LIMITS.indexLeaseMs, LIMITS.indexLeaseMs, 1),
  };
}
/** Return valid UTF-8 without splitting a multibyte character at the byte ceiling. */
export function sliceText(text: string, max: number): string {
  const bytes = utf8(text);
  let end = Math.min(max, bytes.length);
  while (end > 0 && end < bytes.length && (bytes[end] & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(bytes.subarray(0, end));
}
