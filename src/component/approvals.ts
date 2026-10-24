import type { FunctionHandle } from "convex/server";
import type { MutationCtx } from "./_generated/server.js";

// Fixed-size references bound coordination metadata even for huge native ids.
export async function approvalKey(id: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Agent 0.7.7's exact native response protocol, without its history planner. */
export async function saveResponses(
  ctx: MutationCtx,
  target: { threadId: string; agent: string; messageId: string; addMessages: string },
  responses: {
    approvalId: string;
    approved: boolean;
    reason?: string;
    providerExecuted?: true;
  }[],
  deniedCalls: { toolCallId: string; toolName: string; providerExecuted?: true }[] = [],
) {
  const saved = (await ctx.runMutation(target.addMessages as FunctionHandle<"mutation">, {
    threadId: target.threadId,
    agentName: target.agent,
    promptMessageId: target.messageId,
    failPendingSteps: false,
    messages: [
      {
        message: {
          role: "tool",
          content: [
            ...responses.map((response) => ({ type: "tool-approval-response", ...response })),
            // A cancelled approval is never resumed as the prompt. AI SDK only
            // synthesizes denied results for responses in the LAST tool message;
            // persist the terminal result too, before a fresh user prompt runs.
            ...deniedCalls.map((call) => ({
              type: "tool-result",
              ...call,
              output: { type: "execution-denied", reason: "cancelled" },
            })),
          ],
        },
      },
    ],
  })) as { messages: { _id: string }[] };
  return saved.messages[0]._id;
}
