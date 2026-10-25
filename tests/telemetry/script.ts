import { stepCountIs, streamText, tool, type Telemetry } from "ai";
import { MockLanguageModelV4 } from "ai/test";
import type {
  LanguageModelV4FinishReason,
  LanguageModelV4StreamPart,
  LanguageModelV4Usage,
} from "@ai-sdk/provider";
import { z } from "zod";
import type { Facts } from "../../src/telemetry/index.js";

export const facts: Facts = {
  subject: "owner",
  rootThreadId: "root",
  threadId: "child",
  runId: "run",
  agent: "Researcher",
  turnKey: "turn",
};
const usage: LanguageModelV4Usage = {
  inputTokens: { total: 7, noCache: 7, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 3, text: 3, reasoning: 0 },
};
function response(parts: LanguageModelV4StreamPart[]) {
  return {
    stream: new ReadableStream<LanguageModelV4StreamPart>({
      start(controller) {
        for (const part of parts) controller.enqueue(part);
        controller.close();
      },
    }),
  };
}

/** Real AI SDK dispatch, two model steps, one locally executed tool; no HTTP. */
export async function scripted(
  integration: Telemetry,
  options: {
    input?: string;
    output?: string;
    toolFails?: boolean;
    recordInputs?: boolean;
    recordOutputs?: boolean;
    modelId?: string;
    toolName?: string;
    finishReason?: LanguageModelV4FinishReason["unified"];
  } = {},
) {
  const model = new MockLanguageModelV4({
    provider: "scripted",
    modelId: options.modelId ?? "scripted-model",
    doStream: [
      response([
        { type: "stream-start", warnings: [] },
        {
          type: "tool-call",
          toolCallId: "random-tool-id",
          toolName: options.toolName ?? "lookup",
          input: JSON.stringify({ query: options.input ?? "private tool input" }),
        },
        { type: "finish", finishReason: { unified: "tool-calls", raw: "tool_calls" }, usage },
      ]),
      response([
        { type: "stream-start", warnings: [] },
        { type: "text-start", id: "text" },
        { type: "text-delta", id: "text", delta: options.output ?? "private model output" },
        { type: "text-end", id: "text" },
        {
          type: "finish",
          finishReason: { unified: options.finishReason ?? "stop", raw: "stop" },
          usage,
        },
      ]),
    ],
  });
  const result = streamText({
    model,
    prompt: options.input ?? "private prompt",
    system: "private system",
    maxRetries: 0,
    stopWhen: stepCountIs(2),
    tools: {
      [options.toolName ?? "lookup"]: tool({
        inputSchema: z.object({ query: z.string() }),
        execute: () => {
          if (options.toolFails) throw new Error("private tool error");
          return "private tool output";
        },
      }),
    },
    telemetry: {
      integrations: [integration],
      recordInputs: options.recordInputs,
      recordOutputs: options.recordOutputs,
    },
  });
  await result.consumeStream();
  return result.text;
}
