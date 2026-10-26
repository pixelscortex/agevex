/** Native Agent 0.7.7 vercel/mapping.ts:305-323 serializes usage/metadata but
 * omits step.response.id. Preserve the provider's exact id in that SAME native
 * save. OpenRouter 3.1.0 dist/index.js:4543-4545,4638-4639 exposes it in both modes.
 */
import type { SharedV4ProviderMetadata } from "@ai-sdk/provider";
/** No synthetic request ids; oversized ids stay unavailable for reconciliation. */
export declare function providerEvidence(metadata: SharedV4ProviderMetadata | undefined, requestId: string | undefined): SharedV4ProviderMetadata | undefined;
