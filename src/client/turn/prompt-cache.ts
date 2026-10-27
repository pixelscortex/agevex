// Ephemeral, per-request Claude markers. Native Agent owns saved messages;
// keeping hints here avoids persisting breakpoints that accumulate on replay.

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
export function claudeCacheProvider(model: LanguageModel): CacheProvider | undefined {
  if (typeof model === "string") return undefined;

  if (model.provider.startsWith("openrouter") && model.modelId.startsWith("anthropic/"))
    return "openrouter";

  if (model.provider.startsWith("anthropic")) return "anthropic";

  return undefined;
}

/** Add at most two breakpoints, only when the app has supplied none. */
export function claudeCacheOptions(request: CacheRequest): {
  instructions?: Instructions;
  messages?: ModelMessage[];
  providerOptions?: ProviderOptions;
} {
  const provider = claudeCacheProvider(request.model);

  if (!provider || request.enabled === false || hasAppHints(request, provider)) return {};

  const prefix = markPrefix(request, provider);

  if (provider === "openrouter")
    // OpenRouter 3.1.0 dist/index.js:4357-4358,4555-4556 forwards this
    // camel-case call option as top-level cache_control in both call modes.
    return { ...prefix, providerOptions: cacheOptions(request.providerOptions, provider) };

  const messages = prefix.messages ?? request.messages;
  const last = messages[messages.length - 1];

  if (!last || last.role === "system") return prefix;

  const content =
    typeof last.content === "string"
      ? [{ type: "text" as const, text: last.content }]
      : last.content;

  const part = content[content.length - 1];

  if (!part) return prefix;

  // Direct Anthropic consumes content-part hints, including tool results.
  // Copy only the changed path; the native prompt/history remains untouched.
  const marked = {
    ...part,
    providerOptions: cacheOptions(
      "providerOptions" in part ? part.providerOptions : undefined,
      provider,
    ),
  };

  const message = { ...last, content: [...content.slice(0, -1), marked] } as ModelMessage;

  return { ...prefix, messages: [...messages.slice(0, -1), message] };
}

/** Mark the final system block so the preceding tools share its cache prefix. */
function markPrefix(request: CacheRequest, provider: CacheProvider) {
  const index = request.messages.reduce(
    (last, message, i) => (message.role === "system" ? i : last),
    -1,
  );

  if (index >= 0) {
    const messages = request.messages.map((message, i) =>
      i === index
        ? { ...message, providerOptions: cacheOptions(message.providerOptions, provider) }
        : message,
    );

    return { messages };
  }

  const { instructions } = request;

  if (instructions === undefined) return {};

  const blocks =
    typeof instructions === "string"
      ? [{ role: "system" as const, content: instructions }]
      : Array.isArray(instructions)
        ? instructions
        : [instructions];

  const last = blocks[blocks.length - 1];

  if (!last) return {};

  return {
    instructions: [
      ...blocks.slice(0, -1),
      {
        ...last,
        providerOptions: cacheOptions(last.providerOptions, provider),
      },
    ],
  };
}

/** Merge within the provider namespace too; no TTL means Anthropic's 5 minutes. */
function cacheOptions(
  options: ProviderOptions | undefined,
  provider: CacheProvider,
): ProviderOptions {
  return {
    ...options,
    [provider]: { ...options?.[provider], cacheControl: { type: "ephemeral" } },
  };
}

/** OpenRouter also consumes anthropic aliases. Treat even an explicit null as app ownership. */
function hasHint(options: ProviderOptions | undefined, provider: CacheProvider): boolean {
  const namespaces = provider === "openrouter" ? ["openrouter", "anthropic"] : ["anthropic"];

  return namespaces.some((name) => {
    const value = options?.[name];

    return (
      typeof value === "object" &&
      value !== null &&
      ("cacheControl" in value || "cache_control" in value)
    );
  });
}

/** Tool-result outputs carry their own hints (Anthropic dist ~2522-2535). */
function outputHints(part: object): (ProviderOptions | undefined)[] {
  if (!("output" in part) || typeof part.output !== "object" || part.output === null) return [];

  const output = part.output as {
    type?: string;
    providerOptions?: ProviderOptions;
    value?: unknown;
  };

  // Only `content` outputs hold parts; json/error-json values are app data.
  const nested =
    output.type === "content" && Array.isArray(output.value)
      ? output.value.map(
          (item: { providerOptions?: ProviderOptions } | null) => item?.providerOptions,
        )
      : [];

  return [output.providerOptions, ...nested];
}

type CacheBody = { cache_control?: unknown; extraBody?: { cache_control?: unknown } };

/**
 * OpenRouter model settings and extra bodies send top-level cache_control
 * (dist ~4324-4325). A wrapped model hides these; such apps opt out instead.
 */
function modelHint(model: LanguageModel, provider: CacheProvider): boolean {
  if (provider !== "openrouter" || typeof model === "string") return false;

  const { settings, config } = model as { settings?: CacheBody; config?: CacheBody };

  return (
    settings?.cache_control != null ||
    settings?.extraBody?.cache_control != null ||
    config?.extraBody?.cache_control != null
  );
}

/** Inspect hint locations, never arbitrary user text, tool inputs or result data. */
function hasAppHints(request: CacheRequest, provider: CacheProvider): boolean {
  const instructions =
    typeof request.instructions === "string" || !request.instructions
      ? []
      : Array.isArray(request.instructions)
        ? request.instructions
        : [request.instructions];

  return (
    modelHint(request.model, provider) ||
    hasHint(request.providerOptions, provider) ||
    Object.values(request.tools ?? {}).some((tool) => hasHint(tool.providerOptions, provider)) ||
    [...instructions, ...request.messages].some(
      (message) =>
        hasHint(message.providerOptions, provider) ||
        (Array.isArray(message.content) &&
          message.content.some((part) =>
            [
              "providerOptions" in part ? part.providerOptions : undefined,
              ...outputHints(part),
            ].some((options) => hasHint(options, provider)),
          )),
    )
  );
}
