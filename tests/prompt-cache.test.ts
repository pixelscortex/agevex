// Cache-policy guarantees at the SDK boundary, without a backend or network.
import { expect, it } from "vite-plus/test";
import { mockModel } from "@convex-dev/agent";
import { jsonSchema, type Instructions, type ModelMessage, type ToolSet } from "ai";
import type { ProviderOptions } from "@ai-sdk/provider-utils";
import { claudeCacheOptions, claudeCacheProvider } from "../src/client/turn/prompt-cache.js";

const ephemeral = { type: "ephemeral" };

const model = (provider = "openrouter.chat", modelId = "anthropic/claude-sonnet-4.6") =>
  mockModel({ provider, modelId });

it.each([
  ["openrouter.chat", "anthropic/claude-sonnet-4.6", "openrouter"],
  ["openrouter", "anthropic/claude-opus-4.6", "openrouter"],
  ["anthropic.messages", "claude-sonnet-4.6", "anthropic"],
  ["anthropic", "claude-opus-4.6", "anthropic"],
  ["openrouter.chat", "openai/gpt-5", undefined],
  ["openrouter.chat", "google/gemini", undefined],
  ["mock", "anthropic/claude-sonnet-4.6", undefined],
  ["bedrock", "anthropic.claude", undefined],
  ["vertex.anthropic", "claude-sonnet-4.6", undefined],
  ["openai.responses", "claude", undefined],
])("detection uses provider %s and model %s", (provider, modelId, expected) => {
  expect(claudeCacheProvider(model(provider, modelId))).toBe(expected);
});

it("unresolved string model ids never enable Claude caching", () => {
  expect(claudeCacheProvider("anthropic/claude-sonnet-4.6")).toBeUndefined();
});

it.each(["openrouter", "anthropic"] as const)(
  "%s merges hints without mutating instructions, messages or provider options",
  (provider) => {
    const request = {
      model: model(provider),
      instructions: [
        { role: "system" as const, content: "first" },
        {
          role: "system" as const,
          content: "last",
          providerOptions: { [provider]: { other: true } },
        },
      ],
      messages: [
        {
          role: "user" as const,
          content: [
            { type: "text" as const, text: "first" },
            {
              type: "text" as const,
              text: "last",
              providerOptions: { [provider]: { other: true } },
            },
          ],
        },
      ],
      providerOptions: { [provider]: { other: true }, untouched: { value: true } },
    };

    const before = structuredClone({ ...request, model: undefined });
    const result = claudeCacheOptions(request);

    expect(result.instructions).toEqual([
      request.instructions[0],
      {
        ...request.instructions[1],
        providerOptions: { [provider]: { other: true, cacheControl: ephemeral } },
      },
    ]);

    if (provider === "openrouter") {
      expect(result.providerOptions).toEqual({
        [provider]: { other: true, cacheControl: ephemeral },
        untouched: { value: true },
      });
    } else {
      expect(result.messages).toEqual([
        {
          role: "user",
          content: [
            request.messages[0].content[0],
            {
              ...request.messages[0].content[1],
              providerOptions: { [provider]: { other: true, cacheControl: ephemeral } },
            },
          ],
        },
      ]);
    }

    expect({ ...request, model: undefined }).toEqual(before);
  },
);

const locations = [
  "instructions",
  "system",
  "message",
  "part",
  "call",
  "tool",
  "tool output",
  "tool output content",
] as const;

it.each(locations)("an app hint on %s owns caching for the whole call", (location) => {
  for (const provider of ["openrouter", "anthropic"] as const) {
    for (const namespace of provider === "openrouter"
      ? ["openrouter", "anthropic"]
      : ["anthropic"]) {
      for (const key of ["cacheControl", "cache_control"]) {
        const hint = { [namespace]: { [key]: ephemeral } };

        const request: {
          model: ReturnType<typeof model>;
          instructions: Instructions;
          messages: ModelMessage[];
          providerOptions?: ProviderOptions;
          tools?: ToolSet;
        } = {
          model: model(provider),
          instructions: "stable",
          messages: [{ role: "user", content: "hi" }],
        };

        if (location === "instructions")
          request.instructions = { role: "system", content: "stable", providerOptions: hint };

        if (location === "system")
          request.messages.unshift({ role: "system", content: "stable", providerOptions: hint });

        if (location === "message") request.messages[0].providerOptions = hint;

        if (location === "part")
          request.messages = [
            { role: "user", content: [{ type: "text", text: "hi", providerOptions: hint }] },
          ];

        if (location === "call") request.providerOptions = hint;

        if (location === "tool output" || location === "tool output content")
          request.messages = [
            {
              role: "tool",
              content: [
                {
                  type: "tool-result",
                  toolCallId: "call",
                  toolName: "echo",
                  output:
                    location === "tool output"
                      ? { type: "text", value: "ok", providerOptions: hint }
                      : {
                          type: "content",
                          value: [{ type: "text", text: "ok", providerOptions: hint }],
                        },
                } as never,
              ],
            },
          ];

        if (location === "tool")
          request.tools = {
            owned: { inputSchema: jsonSchema({ type: "object" }), providerOptions: hint },
          };

        expect(claudeCacheOptions(request)).toEqual({});
      }
    }
  }
});

it("the last system message gets the prefix marker without changing message count or order", () => {
  const messages: ModelMessage[] = [
    { role: "system", content: "first" },
    { role: "system", content: "last" },
    { role: "user", content: "hi" },
  ];

  const result = claudeCacheOptions({ model: model(), messages });

  expect(result.messages).toEqual([
    messages[0],
    { ...messages[1], providerOptions: { openrouter: { cacheControl: ephemeral } } },
    messages[2],
  ]);
});

it("no instructions or empty content never introduces a new message or content block", () => {
  expect(claudeCacheOptions({ model: model("anthropic"), messages: [], instructions: [] })).toEqual(
    {},
  );

  expect(
    claudeCacheOptions({ model: model("anthropic"), messages: [{ role: "user", content: [] }] }),
  ).toEqual({});
});

it("OpenRouter model-level cache_control owns caching for the whole call", () => {
  const owned = Object.assign(model(), {
    settings: { cache_control: { type: "ephemeral", ttl: "1h" } },
  });

  expect(
    claudeCacheOptions({
      model: owned,
      instructions: "stable",
      messages: [{ role: "user", content: "hi" }],
    }),
  ).toEqual({});
});

it.each([
  ["model extraBody", { settings: { extraBody: { cache_control: { type: "ephemeral" } } } }],
  ["provider extraBody", { config: { extraBody: { cache_control: { type: "ephemeral" } } } }],
])("OpenRouter %s cache_control owns caching for the whole call", (_name, extra) => {
  expect(
    claudeCacheOptions({
      model: Object.assign(model(), extra),
      instructions: "stable",
      messages: [{ role: "user", content: "hi" }],
    }),
  ).toEqual({});
});

it.each(["json", "error-json"] as const)(
  "%s tool data that looks like hints is app data, never a hint or a crash",
  (type) => {
    for (const provider of ["openrouter", "anthropic"] as const) {
      const result = claudeCacheOptions({
        model: model(provider),
        instructions: "stable",
        messages: [
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call",
                toolName: "echo",
                output: {
                  type,
                  value: [{ providerOptions: { anthropic: "plain data", openrouter: null } }],
                },
              } as never,
            ],
          },
        ],
      });

      expect(result.instructions).toBeDefined();
    }
  },
);
