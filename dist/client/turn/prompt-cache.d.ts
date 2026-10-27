import type { Instructions, LanguageModel, ModelMessage, ToolSet } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
type CacheProvider = "openrouter" | "anthropic";
type CacheRequest = {
    model: LanguageModel;
    instructions?: Instructions;
    messages: ModelMessage[];
    tools?: ToolSet;
    providerOptions?: ProviderOptions;
    enabled?: boolean;
};
/** Match the actual step model, never a host's unresolved string model id. */
export declare function claudeCacheProvider(model: LanguageModel): CacheProvider | undefined;
/** Add at most two breakpoints, only when the app has supplied none. */
export declare function claudeCacheOptions(request: CacheRequest): {
    instructions?: Instructions;
    messages?: ModelMessage[];
    providerOptions?: ProviderOptions;
};
export {};
