// Installed provider converters must serialize the policy to real wire keys.
import { expect, it } from "vite-plus/test";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { createAnthropic } from "@ai-sdk/anthropic";
import { generateText, streamText, tool, type LanguageModel, type ToolSet } from "ai";
import { z } from "zod";
import { claudeCacheOptions } from "../src/client/turn/prompt-cache.js";

const ephemeral = { type: "ephemeral" };

async function capture(provider: "openrouter" | "anthropic", mode: "generate" | "stream") {
  let body: Record<string, any> | undefined;

  const fetch: typeof globalThis.fetch = async (_url, init) => {
    if (typeof init?.body !== "string") throw new Error("EXPECTED_JSON_BODY");

    body = JSON.parse(init.body);
    // Stop after serialization. No request, tokens or credentials leave the process.
    throw new Error("captured request");
  };

  const model: LanguageModel =
    provider === "openrouter"
      ? createOpenRouter({ apiKey: "fake", fetch })("anthropic/claude-sonnet-4.6")
      : createAnthropic({ apiKey: "fake", fetch })("claude-sonnet-4.6");

  const tools = { echo: tool({ inputSchema: z.object({ text: z.string() }) }) };

  const options = {
    model,
    instructions: "stable system",
    messages: [{ role: "user" as const, content: "hello" }],
    tools,
    providerOptions: { [provider]: { temperature: 0.4 } },
    maxRetries: 0,
    prepareStep: (step: Parameters<import("ai").PrepareStepFunction<ToolSet>>[0]) =>
      claudeCacheOptions({ ...step, tools, providerOptions: { [provider]: { temperature: 0.4 } } }),
  };

  if (mode === "generate") await expect(generateText(options)).rejects.toThrow("captured request");
  else {
    const result = streamText({ ...options, onError: () => {} });

    await expect(result.text).rejects.toThrow();
  }

  expect(body).toBeDefined();

  return body!;
}

it.each(["generate", "stream"] as const)(
  "OpenRouter %s serializes the prefix and automatic rolling cache controls",
  async (mode) => {
    const body = await capture("openrouter", mode);

    expect(body.cache_control).toEqual(ephemeral);

    expect(body.messages[0]).toEqual({
      role: "system",
      content: [{ type: "text", text: "stable system", cache_control: ephemeral }],
    });

    expect(body.tools.map((entry: any) => entry.function.name)).toEqual(["echo"]);
    expect(JSON.stringify(body)).not.toContain('"ttl"');
    expect(body.temperature).toBe(0.4);
  },
);

it.each(["generate", "stream"] as const)(
  "direct Anthropic %s serializes exactly two breakpoints",
  async (mode) => {
    const body = await capture("anthropic", mode);

    expect(body.system).toEqual([
      { type: "text", text: "stable system", cache_control: ephemeral },
    ]);

    expect(body.messages[0].content).toEqual([
      { type: "text", text: "hello", cache_control: ephemeral },
    ]);

    expect((JSON.stringify(body).match(/"cache_control"/g) ?? []).length).toBe(2);
    expect(JSON.stringify(body)).not.toContain('"ttl"');
  },
);
