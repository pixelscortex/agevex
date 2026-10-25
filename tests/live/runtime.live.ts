import { requireReceipt } from "../receipt.js";
import { writeFile } from "node:fs/promises";
import { it, expect } from "vite-plus/test";
import { convexTest } from "convex-test";
import agent from "@convex-dev/agent/test";
import { anyApi, type ApiFromModules } from "convex/server";
import { LIVE_LIMITS } from "./config.js";
import agevex from "../../src/test.js";
import schema from "../fixture/schema.js";
import { live, modelId } from "./convex/agents.js";
import type * as agents from "./convex/agents.js";

declare const process: { env: Record<string, string | undefined> };
const api = anyApi as unknown as ApiFromModules<{ agents: typeof agents }>;
const modules = import.meta.glob(["./convex/**/*.ts", "./convex/**/*.js"]);

it.skipIf(!process.env.OPENROUTER_API_KEY)(
  "live plain turn, repeated delegation, depth-two round trip and passive critic side review",
  async () => {
    const scenarios = [];
    try {
      for (const scenario of ["plain", "delegation", "depth", "critic"] as const) {
        const delegation = scenario === "delegation";
        const depth = scenario === "depth";
        const critic = scenario === "critic";
        live.criticCalls = 0;
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
            agent: critic ? "Watched" : "Main",
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
            history: delegation || depth ? 2 : critic ? 1 : 0,
            rootCalls: depth ? 2 : delegation ? 3 : 1,
            // Passive critic notes have their own capacity, never ready work.
            queued: 0,
            errorCode: null,
          });
        if (critic) {
          expect(live.criticCalls).toBe(1);
          // R3 lets the watched parent finish before its side review's native
          // note delivery commits. An inactive child is settled, not necessarily
          // delivered; wait for the promised note rather than racing that write.
          await expect
            .poll(
              async () => {
                const deliveries = await owner.query(api.agents.delegations, {
                  threadId: receipt.threadId,
                  paginationOpts: { cursor: null, numItems: 20 },
                });
                const failed = deliveries.page.find(
                  (run) => run.deliveryStatus === "failed" || run.deliveryStatus === "blocked",
                );
                if (failed) throw new Error(`LIVE_CRITIC_DELIVERY_FAILED:${failed.errorCode}`);
                const transcript = await owner.query(api.agents.messages, {
                  threadId: receipt.threadId,
                  paginationOpts: { cursor: null, numItems: 20 },
                });
                return transcript.page.some(
                  (message) =>
                    message.role === "user" && message.text.includes('<note from="Critic">'),
                );
              },
              { timeout: 180_000, interval: 200 },
            )
            .toBe(true);
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
            tree.map((run) => ({ agent: run.agent, depth: run.depth, status: run.status })),
            JSON.stringify(deliveries.page),
          ).toEqual([
            { agent: "Builder", depth: 1, status: "completed" },
            { agent: "Reviewer", depth: 2, status: "completed" },
          ]);
        }
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
      expect(live.usd).toBeLessThanOrEqual(
        Number(process.env.OPENROUTER_LIVE_MAX_USD ?? LIVE_LIMITS.maxUsd),
      );
      const evidence = JSON.stringify({
        scenarios,
        requestedModel: modelId,
        routedModels: [...live.models],
        requests: live.requests,
        responses: live.responses,
        inputTokens: live.inputTokens,
        outputTokens: live.outputTokens,
        usd: live.costReported ? live.usd : null,
      });
      await writeFile(".vite-plus/live-results.json", evidence + "\n");
      console.log(evidence);
    }
  },
  360_000,
);
