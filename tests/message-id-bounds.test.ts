/** Native id bounds reserve UTF-8 framing for the whole reporting turn. */
import { expect, it } from "vite-plus/test";
import { getConvexSize } from "convex/values";
import type { MessageDoc } from "@convex-dev/agent";
import type { Doc, Id } from "../src/component/_generated/dataModel.js";
import { LIMITS } from "../src/component/limits.js";
import { appendTurnMessages } from "../src/component/turns/message-ids.js";
import { fullReport } from "./assignment-envelope.fixture.js";

it("a complete 64-id report with maximum native ids fits its 3 KiB reservation", () => {
  const report = fullReport("r".repeat(LIMITS.messageIdBytes) as Id<"inbox">);

  expect(getConvexSize(report)).toBeLessThanOrEqual(LIMITS.turnReportBytes);
  expect(getConvexSize(report.messageIds[0])).toBe(39);
});

it.each(["m".repeat(37), "m".repeat(38), "é".repeat(37)])(
  "assistant saves enforce the native id's 37 ASCII character maximum: %s",
  (id) => {
    const row = {
      turnReport: { promptMessageId: "prompt", messageIds: [], maxMessages: 64 },
    } as unknown as Doc<"assignments">;

    const messages = [
      { _id: id, status: "success", message: { role: "assistant", content: "saved" } },
    ] as MessageDoc[];

    if (id === "m".repeat(37)) expect(appendTurnMessages(row, messages)?.messageIds).toEqual([id]);
    else expect(() => appendTurnMessages(row, messages)).toThrow("MESSAGE_ID_TOO_LARGE");
  },
);
