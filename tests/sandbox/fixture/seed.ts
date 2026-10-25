import { v } from "convex/values";
import { mutation } from "../../../src/component/_generated/server.js";
import { newRootAssignment } from "../../../src/component/turns/assignments.js";
import { resolveLimits } from "../../../src/component/limits.js";

// Test-only module mounted inside the real core component. Seed an active
// execution so bindOnceTool exercises core's actual epoch/claim checks rather
// than replacing the receipt ledger with a mock implementation.
export const seed = mutation({
  args: {},
  returns: v.id("assignments"),
  handler: (ctx) =>
    ctx.db.insert("assignments", {
      ...newRootAssignment({
        subject: "owner",
        agent: "SandboxTest",
        threadId: "thread",
        runTurn: "unused",
        limits: resolveLimits(),
      }),
      turnStatus: "running",
      turnToken: "execution",
    }),
});
