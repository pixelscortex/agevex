import { readFile, writeFile } from "node:fs/promises";
import { expect, it } from "vite-plus/test";
import { Agent, saveMessage, type UsageHandler } from "@convex-dev/agent";
import type { LanguageModelV4 } from "@ai-sdk/provider";
import agent from "@convex-dev/agent/test";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { componentsGeneric } from "convex/server";
import type { ComponentApi as AgentComponent } from "@convex-dev/agent/_generated/component.js";
import { usageHandlerFor } from "../../src/meter/index.js";
import { setup } from "./setup.js";

// Avoid the native constructor's intersection of two expanding gateway unions
// (TS2590); this is the same instance and the exact supported provider object.
const NativeAgent = Agent as unknown as new (
  component: AgentComponent,
  options: {
    name: string;
    languageModel: LanguageModelV4;
    usageHandler?: UsageHandler;
  },
) => Agent<object, Record<string, never>>;
const LIVE_LIMITS = { maxOutputTokens: 256, timeoutMs: 120_000 };
// The private environment file is read only for the one test credential, never
// logged or copied into evidence. Explicitly sourcing it keeps this cheap test
// usable without exposing keys in shell arguments or relying on shell startup.
async function key() {
  if (process.env.OPENROUTER_API_KEY) return process.env.OPENROUTER_API_KEY;
  const env = await readFile("/Volumes/mypixel/pxc/agevex/.env.local", "utf8").catch(() => "");
  return env.match(/^OPENROUTER_API_KEY\s*=\s*["']?([^\r\n"']+)/m)?.[1];
}

const apiKey = await key();
it.skipIf(!apiKey)(
  "one live OpenRouter free saved step records authoritative inline cost including zero",
  async () => {
    if (!apiKey) throw new Error("OPENROUTER_KEY_REQUIRED");
    const { t, meter, component } = setup();
    agent.register(t);
    const native = componentsGeneric().agent as unknown as AgentComponent;
    let requests = 0;
    const provider = createOpenRouter({
      apiKey,
      fetch: async (url, init) => {
        if (++requests > 1) throw new Error("LIVE_REQUEST_CAP");
        const body = JSON.parse(String(init?.body)) as { usage?: { include?: boolean } };
        expect(body.usage?.include).toBe(true);
        return await fetch(url, init);
      },
    });
    let inputTokens = 0;
    let outputTokens = 0;
    let savedStepKey = "";
    await t.action(async (ctx) => {
      // Allocate the native prompt id directly. The usage hook in 0.7.7 does
      // not provide it; this is stable saved-message identity without a scan.
      const probe = new NativeAgent(native, {
        name: "MeterLive",
        languageModel: provider.chat("openrouter/free", { usage: { include: true } }),
      });
      const { threadId } = await probe.createThread(ctx, { userId: "meter-live" });
      const saved = await saveMessage(ctx, native, {
        threadId,
        prompt: "Reply with only the word hello.",
      });
      savedStepKey = JSON.stringify([threadId, saved.messageId, 0]);
      const handler = usageHandlerFor(meter, {
        provider: "openrouter",
        identity: () => ({ subject: "meter-live", messageId: saved.messageId, step: 0 }),
      });
      const liveAgent = new NativeAgent(native, {
        name: "MeterLive",
        languageModel: provider.chat("openrouter/free", { usage: { include: true } }),
        usageHandler: async (context, args) => {
          inputTokens += args.usage.inputTokens ?? 0;
          outputTokens += args.usage.outputTokens ?? 0;
          await handler(context, args);
        },
      });
      await liveAgent.generateText(
        ctx,
        { threadId },
        {
          promptMessageId: saved.messageId,
          maxOutputTokens: LIVE_LIMITS.maxOutputTokens,
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(LIVE_LIMITS.timeoutMs),
        },
      );
      const charge = await ctx.runQuery(component.charges.get, { key: savedStepKey });
      expect(charge).toMatchObject({ status: "settled", source: "inline" });
      expect(charge?.nanos).toBeTypeOf("number");
      const cost = await meter.threadCost(ctx, { threadId });
      expect(cost.unknown).toBe(0);
      const evidence = {
        model: "openrouter/free",
        requests,
        inputTokens,
        outputTokens,
        nanos: charge?.nanos,
        source: charge?.source,
        polarCalls: 0,
      };
      await writeFile(".vite-plus/meter-live-results.json", JSON.stringify(evidence) + "\n");
      console.log(JSON.stringify(evidence));
    });
  },
  LIVE_LIMITS.timeoutMs,
);
