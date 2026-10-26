/**
 * Fixed-size keys for native ids, and the native approval-response save.
 *
 * Native approval ids and tool-call ids can be near 1 MiB, so coordination
 * rows store their SHA-256 (`callKey` bytes, `approvalKey` hex) instead.
 * `saveResponses` writes approval responses and cancellation's
 * "execution-denied" tool results in Agent 0.7.7's exact native protocol.
 * Used by turns/ (pause.ts, approvals.ts), subagents/launch.ts (dedup keys) and
 * cancellation/cleanup.ts. Reads and writes no agevex table.
 */
import type { FunctionHandle } from "convex/server";
import type { MessageDoc } from "@convex-dev/agent";
import type { MutationCtx } from "./_generated/server.js";
import { getConvexSize } from "convex/values";
import { LIMITS } from "./limits.js";

// Fixed-size references bound coordination metadata even for huge native ids.
export const callKey = (id: string) =>
  crypto.subtle.digest("SHA-256", new TextEncoder().encode(id));

export function keyString(digest: ArrayBuffer): string {
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function approvalKey(id: string): Promise<string> {
  return keyString(await callKey(id));
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
  const message = {
    role: "tool" as const,
    content: [
      ...responses.map((response) => ({ type: "tool-approval-response", ...response })),
      ...deniedCalls.map((call) => ({
        type: "tool-result",
        ...call,
        output: { type: "execution-denied", reason: "cancelled" },
      })),
    ],
  };

  // Cleanup sends one response/result pair at a time. Reserve native envelope
  // space too, then check the actual returned document before committing.
  if (deniedCalls.length && getConvexSize(message) + 4096 > LIMITS.cleanupMessageBytes)
    throw new Error("CLEANUP_MESSAGE_TOO_LARGE");

  const saved = (await ctx.runMutation(target.addMessages as FunctionHandle<"mutation">, {
    threadId: target.threadId,
    agentName: target.agent,
    promptMessageId: target.messageId,
    failPendingSteps: false,
    messages: [{ message }],
  })) as { messages: MessageDoc[] };

  if (
    deniedCalls.length &&
    saved.messages.some((doc) => getConvexSize(doc) > LIMITS.cleanupMessageBytes)
  )
    throw new Error("CLEANUP_MESSAGE_TOO_LARGE");

  return saved.messages[0]._id;
}
