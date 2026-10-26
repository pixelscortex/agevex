/** Real Agent merge heads for all three statuses and tool/non-tool branches. */
import { getConvexSize } from "convex/values";
import type { setup } from "./setup.js";
import { components } from "./fixture/api.js";

export async function fillNativeHeads(
  t: Pick<ReturnType<typeof setup>, "query" | "mutation">,
  threadId: string,
  promptMessageId: string,
  orderOffset = 0,
) {
  const [anchor] = await t.query(components.agent.messages.getMessagesByIds, {
    messageIds: [promptMessageId],
  });

  for (const status of ["success", "pending", "failed"] as const)
    for (const tool of [false, true]) {
      const saved = await t.mutation(components.agent.messages.addMessages, {
        threadId,
        order: anchor!.order + orderOffset,
        failPendingSteps: false,
        messages: [
          {
            status,
            message: tool
              ? {
                  role: "tool",
                  content: [
                    {
                      type: "tool-result",
                      toolCallId: status,
                      toolName: "echo",
                      output: { type: "text", value: "x".repeat(1020 << 10) },
                    },
                  ],
                }
              : { role: "user", content: "x".repeat(510 << 10) },
          },
        ],
      });

      if (getConvexSize(saved.messages[0]) < 1020 << 10)
        throw new Error("FIXTURE_NATIVE_HEAD_TOO_SMALL");
    }
}
