import { requireReceipt } from "../receipt.js";
import { writeFile } from "node:fs/promises";
import { it, expect } from "vite-plus/test";
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import { anyApi, type ApiFromModules } from "convex/server";
import { LIVE_MODELS, LIVE_LIMITS } from "./config.js";
import agevex from "../../src/test.js";
import schema from "../fixture/schema.js";
import { z } from "zod";
import { defineTask, runTask } from "../../src/client/index.js";
import { components } from "../fixture/api.js";
import { live, modelId, taskModel, fakeUsage } from "./convex/agents.js";
import type * as agents from "./convex/agents.js";

declare const process: { env: Record<string, string | undefined> };
const api = anyApi as unknown as ApiFromModules<{ agents: typeof agents }>;
const modules = import.meta.glob(["./convex/**/*.ts", "./convex/**/*.js"]);

it.skipIf(!process.env.OPENROUTER_API_KEY)(
  "live structured task, metered turn, delegation, depth-two round trip",
  async () => {
    const scenarios = [];

    try {
      const classify = defineTask({
        name: "live-classify",
        input: z.string(),
        output: z.object({ answer: z.string() }),
        prompt: (value) => `Return JSON with answer containing only the word ${value}.`,
        model: taskModel,
        repair: 0,
      });

      const tasks = convexTest(schema, modules);

      agent.register(tasks);
      agevex.register(tasks);
      const beforeTask = live.charges.length;

      expect(
        await tasks.action((ctx) =>
          runTask(ctx, classify, "hello", {
            component: components.agevex,
            key: "live-structured",
            usage: fakeUsage,
            attribution: {
              subject: "live-owner",
              rootThreadId: "task",
              threadId: "task",
              runId: "task",
              agent: "Classifier",
            },
          }),
        ),
      ).toMatchObject({ status: "done", value: { answer: expect.any(String) } });

      await Promise.all(live.evidence);
      const taskCharge = live.charges[beforeTask];

      scenarios.push({ scenario: "structured-task", usage: taskCharge?.usage });
      expect(taskCharge?.usage).toBeTruthy();

      for (const scenario of ["plain", "delegation", "depth"] as const) {
        live.scenario = scenario;
        const delegation = scenario === "delegation";
        const depth = scenario === "depth";

        const before = { input: live.inputTokens, output: live.outputTokens };
        const t = convexTest(schema, modules);

        agent.register(t);
        agevex.register(t);
        const owner = t.withIdentity({ subject: "live-owner" });

        live.delegation = delegation;
        live.depth = depth;
        live.builderCalls = 0;
        live.reviewerCalls = 0;
        live.rootCalls = 0;
        live.childCalls = 0;

        const receipt = await owner
          .mutation(api.agents.open, {
            agent: "Main",
            prompt: depth
              ? "Do a depth-two task: delegate one short task to Builder, which delegates to Reviewer, then answer after Builder completes."
              : delegation
                ? "Delegate a short task to Researcher, then delegate one more short task after its result, then answer."
                : "Say hello in three words.",
            requestKey: scenario,
            ...(scenario === "plain" ? { models: { Main: modelId } } : {}),
          })
          .then(requireReceipt);

        await expect
          .poll(
            async () => {
              const status = await owner.query(api.agents.activity, { threadId: receipt.threadId });

              if (status.turnStatus === "recovery_required")
                throw new Error(`LIVE_TURN_FAILED:${status.errorCode}`);

              return {
                status: status.turnStatus,
                active: status.subagents.active,
                history: status.subagents.history,
                rootCalls: live.rootCalls,
                queued: status.queuedMessages,
                errorCode: status.errorCode,
              };
            },
            { timeout: 180_000, interval: 200 },
          )
          .toEqual({
            status: "idle",
            active: 0,
            history: delegation || depth ? 2 : 0,
            rootCalls: depth ? 2 : delegation ? 3 : 1,
            queued: 0,
            errorCode: null,
          });

        if (scenario === "plain") {
          const charges = live.charges.filter(
            (charge) => charge.facts.threadId === receipt.threadId,
          );

          expect(charges).toHaveLength(1);

          expect(charges[0]).toMatchObject({
            facts: {
              subject: "live-owner",
              rootThreadId: receipt.threadId,
              threadId: receipt.threadId,
              agent: "Main",
            },
            usage: expect.any(Object),
          });
        }

        if (delegation) {
          const runs = await owner.query(api.agents.delegations, {
            threadId: receipt.threadId,
            paginationOpts: { cursor: null, numItems: 20 },
          });

          expect(runs.page).toHaveLength(2);

          expect(
            runs.page.every(
              (run) => run.status === "completed" && run.deliveryStatus === "accepted",
            ),
          ).toBe(true);

          expect(live.childCalls).toBe(2);
        }

        if (depth) {
          expect(live.builderCalls).toBe(2);
          expect(live.reviewerCalls).toBe(1);
          const tree = await owner.query(api.agents.runTree, { threadId: receipt.threadId });

          const deliveries = await owner.query(api.agents.delegations, {
            threadId: receipt.threadId,
            paginationOpts: { cursor: null, numItems: 20 },
          });

          expect(
            tree!.nodes.slice(1).map((run) => ({ agent: run.agent, status: run.status })),
            JSON.stringify(deliveries.page),
          ).toEqual([
            { agent: "Builder", status: "done" },
            { agent: "Reviewer", status: "done" },
          ]);
        }

        await Promise.all(live.evidence);

        scenarios.push({
          scenario,
          inputTokens: live.inputTokens - before.input,
          outputTokens: live.outputTokens - before.output,
        });

        const messages = await owner.query(api.agents.messages, {
          threadId: receipt.threadId,
          paginationOpts: { cursor: null, numItems: 20 },
        });

        expect(
          messages.page.some((message) => message.role === "assistant" && message.text.trim()),
        ).toBe(true);

        await owner.mutation(api.agents.cancel, { threadId: receipt.threadId });
      }
    } finally {
      await Promise.all(live.evidence);

      const evidence = JSON.stringify({
        scenarios,
        requestedModel: modelId,
        fallbackModels: LIVE_MODELS,
        maxUsd: Number(process.env.OPENROUTER_LIVE_MAX_USD ?? LIVE_LIMITS.maxUsd),
        routedModels: [...live.models],
        requests: live.requests,
        responses: live.responses,
        inputTokens: live.inputTokens,
        outputTokens: live.outputTokens,
        usd: live.costReported ? live.usd : null,
      });

      await writeFile(".vite-plus/live-results.json", evidence + "\n");
      console.log(evidence);

      expect(live.usd).toBeLessThanOrEqual(
        Number(process.env.OPENROUTER_LIVE_MAX_USD ?? LIVE_LIMITS.maxUsd),
      );
    }
  },
  360_000,
);
